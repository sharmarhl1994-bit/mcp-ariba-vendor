import { config }         from "../config/env.js";
import { aribaTokens }   from "../auth/token-manager.js";
import { CircuitBreaker } from "../core/circuit-breaker.js";
import { RateLimiter }    from "../core/rate-limiter.js";
import { logger }         from "../core/logger.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface VendorAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?:         string;
  state?:        string;
  postalCode?:   string;
  country?:      string;
}

export interface VendorContact {
  firstName?:   string;
  lastName?:    string;
  email?:       string;
  phone?:       string;
  role?:        string;
}

export interface VendorTaxNumber {
  type?:   string;
  number?: string;
}

export interface VendorBankAccount {
  validFrom?: string;
  validTo?:   string;
  iban?:      string;
  country?:   string;
}

export interface InactiveVendor {
  vendorId:             string;
  name:                 string;
  erpVendorId?:         string;
  acmId?:               string;
  anId?:                string;
  registrationStatus:   string;
  qualificationStatus?: string;
  erpIntStatus?:        string;
  timeUpdated?:         number;
  timeCreated?:         number;
  realm:                string;
}

export interface InactiveVendorListResult {
  vendors:    InactiveVendor[];
  totalCount: number;
}

export interface VendorQualification {
  qualificationStatus?: string;
  preferredStatus?:     string;
  category?:            string;
  region?:              string;
  processType?:         string | null;
}

export interface VendorQuestionnaire {
  questionnaireId?:    string;
  questionnaireTitle?: string;
  workspaceType?:      string;
  workspaceId?:        string;
  status?:             string;
  regions?:            string[];
  categories?:         string[];
}

export interface Vendor {
  vendorId:              string;
  name:                  string;
  registrationStatus:    string;
  qualificationStatus?:  string;
  erpVendorId?:          string;
  acmId?:                string;
  anId?:                 string;
  integratedToErp?:      string;
  lastUpdateDate?:       string;
  lastStatusChangeDate?: string;
  isBlocked?:            boolean;
  primaryAddress?:       VendorAddress;
  taxNumbers?:           VendorTaxNumber[];
  bankAccounts?:         VendorBankAccount[];
  customFields?:         Record<string, string>;
  qualifications?:       VendorQualification[];
  questionnaires?:       VendorQuestionnaire[];
  realm:                 string;
}

export interface VendorListResult {
  vendors:    Vendor[];
  totalCount: number;
  pageToken?: string;        // Ariba uses cursor-based pagination
  hasMore:    boolean;
}

export interface VendorSearchParams {
  // ID filters — sent to Ariba directly
  smVendorIds?:              string[];
  erpVendorIds?:             string[];
  // Server-side list filters
  businessUnitList?:         string[];
  categoryList?:             string[];
  qualificationStatusList?:  string[];
  regionList?:               string[];
  registrationStatusList?:   string[];
  preferredLevelList?:       number[];
  // Include flags
  withQuestionnaire?:        boolean;
  withGenericCustomFields?:  boolean;
  withBankDetail?:           boolean;
  withTaxDetail?:            boolean;
  withCompanyCodeDetail?:    boolean;
  withDisqualifications?:    boolean;
  // Client-side name filter (Ariba has no free-text name search)
  name?:                     string;
  // Pagination
  pageToken?:                string;
  pageSize?:                 number;
}

// ── Infrastructure ─────────────────────────────────────────────────────────────

const breaker = new CircuitBreaker({
  name:              "Ariba-VendorAPI",
  timeout:           config.ARIBA_TIMEOUT_MS,
  errorThresholdPct: 50,
  resetTimeout:      60_000,
  volumeThreshold:   5,
});

const rateLimiter = new RateLimiter(config.RATE_LIMIT_RPM);

interface AribaFetchOptions {
  method?:      "GET" | "POST";
  query?:       Record<string, string>;
  jsonBody?:    unknown;
}

async function aribaFetch(path: string, options: AribaFetchOptions = {}): Promise<unknown> {
  await rateLimiter.acquire();

  const token  = await aribaTokens.getToken();
  const method = options.method ?? "GET";

  // Ariba's OpenAPI (v4) only requires "realm" as a query param — the older
  // passwordAdapter/user params were part of a different (SOAP-era) auth
  // flow and are not part of this REST API's contract.
  const query = new URLSearchParams({
    realm: config.ARIBA_REALM,
    ...(options.query ?? {}),
  });

  const url = `${config.ARIBA_BASE_URL}${path}?${query.toString()}`;

  const doFetch = (bearer: string) =>
    fetch(url, {
      method,
      headers: {
        Authorization:  `Bearer ${bearer}`,
        "apikey":       config.ARIBA_API_KEY,
        Accept:         "application/json",
        "Content-Type": "application/json",
      },
      // GET requests must NOT have a body — fetch() will throw if you pass one
      body: options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : undefined,
    });

  logger.debug("Ariba API call", { method, path, query: options.query, hasBody: options.jsonBody !== undefined });

  let res = await doFetch(token);

  if (res.status === 401) {
    // Token may have been revoked — invalidate cache and retry once
    aribaTokens.invalidate();
    const retryToken = await aribaTokens.getToken();
    res = await doFetch(retryToken);
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error("Ariba API error", { method, path, status: res.status, body });
    throw new Error(`Ariba API request failed [${res.status}]: ${body}`);
  }

  return res.json();
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class VendorAdapter {

  async listVendors(params: VendorSearchParams = {}): Promise<VendorListResult> {
    return breaker.call(async () => {
      const body: Record<string, unknown> = {
        outputFormat: "JSON",
        pageLimit:    params.pageSize ?? config.DEFAULT_PAGE_SIZE,
      };

      // ID filters
      if (params.smVendorIds?.length)             body.smVendorIds             = params.smVendorIds;
      if (params.erpVendorIds?.length)            body.erpVendorIds            = params.erpVendorIds;
      // Server-side list filters
      if (params.businessUnitList?.length)        body.businessUnitList        = params.businessUnitList;
      if (params.categoryList?.length)            body.categoryList            = params.categoryList;
      if (params.qualificationStatusList?.length) body.qualificationStatusList = params.qualificationStatusList;
      if (params.regionList?.length)              body.regionList              = params.regionList;
      if (params.registrationStatusList?.length)  body.registrationStatusList  = params.registrationStatusList;
      if (params.preferredLevelList?.length)      body.preferredLevelList      = params.preferredLevelList;
      // Include flags — default withQuestionnaire true, rest only if explicitly requested
      body.withQuestionnaire       = params.withQuestionnaire       ?? true;
      body.withGenericCustomFields = params.withGenericCustomFields  ?? false;
      body.withBankDetail          = params.withBankDetail           ?? false;
      body.withTaxDetail           = params.withTaxDetail            ?? false;
      body.withCompanyCodeDetail   = params.withCompanyCodeDetail    ?? false;
      body.withDisqualifications   = params.withDisqualifications    ?? false;
      // Pagination cursor
      if (params.pageToken) body.pageToken = params.pageToken;

      const raw = await aribaFetch(
        "/api/supplierdatapagination/v4/prod/vendorDataRequests",
        { method: "POST", jsonBody: body },
      ) as AribaVendorListResponse;

      let result = mapVendorList(raw);

      // Client-side name filter only — all other filters are handled server-side
      if (params.name) {
        const needle = params.name.toLowerCase();
        result = filterVendors(result, v => v.name.toLowerCase().includes(needle));
      }

      return result;
    });
  }

  async getVendor(vendorId: string): Promise<Vendor> {
    return breaker.call(async () => {
      const raw = await aribaFetch(
        `/api/supplierdatapagination/v4/prod/vendors/${encodeURIComponent(vendorId)}/extensionDetails`,
      ) as AribaExtensionDetailsRaw;

      return mapVendorExtension(raw);
    });
  }

  async searchVendorsByName(name: string, pageSize?: number): Promise<VendorListResult> {
    return this.listVendors({ name, pageSize });
  }

  async listInactiveVendors(params: {
    name?:             string;
    smVendorIds?:      string[];
    erpVendorIds?:     string[];
    withQuestionnaire?: boolean;
    pageSize?:         number;
  } = {}): Promise<InactiveVendorListResult> {
    return breaker.call(async () => {
      const body: Record<string, unknown> = {
        outputFormat:      "JSON",
        pageLimit:         params.pageSize ?? config.DEFAULT_PAGE_SIZE,
        withQuestionnaire: params.withQuestionnaire ?? true,
      };

      if (params.smVendorIds?.length)  body.smVendorIds  = params.smVendorIds;
      if (params.erpVendorIds?.length) body.erpVendorIds = params.erpVendorIds;

      const raw = await aribaFetch(
        "/api/supplierdatapagination/v4/prod/inactiveVendorDataRequests/",
        { method: "POST", jsonBody: body },
      ) as AribaInactiveVendorListResponse;

      let vendors = (raw.vendorDetails ?? []).map(mapInactiveVendor);

      if (params.name) {
        const needle = params.name.toLowerCase();
        vendors = vendors.filter(v => v.name.toLowerCase().includes(needle));
      }

      return { vendors, totalCount: vendors.length };
    });
  }

  async getActiveVendors(pageSize?: number): Promise<VendorListResult> {
    return this.listVendors({ registrationStatusList: ["Registered"], pageSize });
  }

  async getNextPage(pageToken: string, pageSize?: number): Promise<VendorListResult> {
    return this.listVendors({ pageToken, pageSize });
  }

  getCircuitState(): string {
    return breaker.getState();
  }
}

// ── Ariba raw response shapes ──────────────────────────────────────────────────
// /api/supplierdatapagination/v4/prod/vendorDataRequests returns a plain array
// with flat "Address - X" fields and space-in-key naming convention.

interface AribaQualificationRaw {
  "Qualification Status"?: string;
  "Preferred Status"?:     string;
  "Category"?:             string;
  "Region"?:               string;
  "Business Unit"?:        string | null;
  "Material ID"?:          string | null;
  "Process Type"?:         string | null;
}

interface AribaQuestionnaireMatrixRaw {
  "Status"?:        string;
  "Region"?:        string[];
  "Category"?:      string[];
  "Business Unit"?: string[];
  "Material ID"?:   string[];
  "Process Type"?:  string[];
}

interface AribaQuestionnaireRaw {
  questionnaireId?:    string;
  questionnaireTitle?: string;
  workspaceType?:      string;
  workspaceId?:        string;
  matrixInfo?:         AribaQuestionnaireMatrixRaw;
}

interface AribaVendorRaw {
  "Supplier Name"?:           string;
  "SM Vendor ID"?:            string;
  "ERP Vendor ID"?:           string;
  "ACM ID"?:                  string;
  "An Id"?:                   string;
  "Registration Status"?:     string;
  "Qualification Status"?:    string;
  "Integrated to ERP"?:       string;
  "Address - Line1"?:         string;
  "Address - Line2"?:         string;
  "Address - City"?:          string;
  "Address - Region Code"?:   string;
  "Address - Country Code"?:  string;
  "Address - Postal Code"?:   string;
  "Last Update Date"?:        string;
  "Last Status Change Date"?: string;
  qualifications?:            AribaQualificationRaw[];
  questionnaires?:            AribaQuestionnaireRaw[];
}

// The vendorDataRequests endpoint returns a plain JSON array (no wrapper object)
type AribaVendorListResponse = AribaVendorRaw[];

// ── inactiveVendorDataRequests raw shape ───────────────────────────────────────
// POST /inactiveVendorDataRequests/ — returns { vendorDetails: [...] }

interface AribaInactiveVendorRaw {
  supplierName?:        string | null;
  name2?:               string | null;
  name3?:               string | null;
  name4?:               string | null;
  erpVendorId?:         string | null;
  smVendorId?:          string | null;
  acmId?:               string | null;
  anId?:                string | null;
  registrationStatus?:  string | null;
  qualificationStatus?: string | null;
  erpIntStatus?:        string | null;
  timeUpdated?:         number | null;
  timeCreated?:         number | null;
}

interface AribaInactiveVendorListResponse {
  vendorDetails?: AribaInactiveVendorRaw[];
}

// ── extensionDetails raw shape ─────────────────────────────────────────────────
// GET /vendors/{id}/extensionDetails — deeply nested SAP Business Partner structure

interface AribaExtensionDetailsRaw {
  internalID?:   string;
  isBlocked?:    boolean;
  organization?: {
    nameDetails?: {
      formattedOrgNameLine1?: string | null;
    };
  };
  addressData?: Array<{
    organizationPostalAddress?: {
      street?:        { name?: string | null } | null;
      houseNumber?:   string | null;
      town?:          { name?: string | null } | null;
      primaryRegion?: { code?: string | null } | null;
      country?:       { code?: string | null } | null;
      postCode?:      string | null;
    } | null;
  }>;
  taxNumbers?: Array<{
    taxNumberType?: { code?: string | null };
    taxNumber?:     string | null;
  }>;
  bankAccounts?: Array<{
    validFrom?: string | null;
    validTo?:   string | null;
    IBAN?:      string | null;
    bankCountry?: { code?: string | null };
  }>;
  supplierGenericCustomField?: Array<{
    name?:    string | null;
    content?: string | null;
    active?:  boolean;
  }>;
  businessPartnerGenericCustomField?: Array<{
    name?:    string | null;
    content?: string | null;
    active?:  boolean;
  }>;
}

// ── Mappers ────────────────────────────────────────────────────────────────────

function mapVendor(r: AribaVendorRaw): Vendor {
  return {
    vendorId:              r["SM Vendor ID"] ?? "UNKNOWN",
    name:                  r["Supplier Name"] ?? "Unknown",
    registrationStatus:    r["Registration Status"] ?? "UNKNOWN",
    qualificationStatus:   r["Qualification Status"],
    erpVendorId:           r["ERP Vendor ID"],
    acmId:                 r["ACM ID"],
    anId:                  r["An Id"],
    integratedToErp:       r["Integrated to ERP"],
    lastUpdateDate:        r["Last Update Date"],
    lastStatusChangeDate:  r["Last Status Change Date"],
    primaryAddress: (r["Address - Line1"] || r["Address - City"] || r["Address - Country Code"])
      ? {
          addressLine1: r["Address - Line1"],
          addressLine2: r["Address - Line2"],
          city:         r["Address - City"],
          state:        r["Address - Region Code"],
          postalCode:   r["Address - Postal Code"],
          country:      r["Address - Country Code"],
        }
      : undefined,
    qualifications: r.qualifications?.map(q => ({
      qualificationStatus: q["Qualification Status"],
      preferredStatus:     q["Preferred Status"],
      category:            q["Category"],
      region:              q["Region"],
      processType:         q["Process Type"],
    })),
    questionnaires: r.questionnaires?.map(q => ({
      questionnaireId:    q.questionnaireId,
      questionnaireTitle: q.questionnaireTitle,
      workspaceType:      q.workspaceType,
      workspaceId:        q.workspaceId,
      status:             q.matrixInfo?.["Status"],
      regions:            q.matrixInfo?.["Region"],
      categories:         q.matrixInfo?.["Category"],
    })),
    realm: config.ARIBA_REALM,
  };
}

function mapVendorExtension(r: AribaExtensionDetailsRaw): Vendor {
  const addr = r.addressData?.[0]?.organizationPostalAddress;

  // Collect all custom fields (supplier + bp) into a flat name→content map
  const customFields: Record<string, string> = {};
  for (const f of [...(r.supplierGenericCustomField ?? []), ...(r.businessPartnerGenericCustomField ?? [])]) {
    if (f.active && f.name && f.content != null) {
      customFields[f.name.trim()] = f.content;
    }
  }

  return {
    vendorId:           r.internalID ?? "UNKNOWN",
    name:               r.organization?.nameDetails?.formattedOrgNameLine1 ?? customFields["FirstName"] ?? "Unknown",
    registrationStatus: "UNKNOWN",   // not present in extensionDetails — caller merges from list if needed
    isBlocked:          r.isBlocked,
    primaryAddress: addr
      ? {
          addressLine1: [addr.street?.name, addr.houseNumber].filter(Boolean).join(" ") || undefined,
          city:         addr.town?.name ?? undefined,
          state:        addr.primaryRegion?.code ?? undefined,
          postalCode:   addr.postCode ?? undefined,
          country:      addr.country?.code ?? undefined,
        }
      : undefined,
    taxNumbers: r.taxNumbers
      ?.filter(t => t.taxNumber)
      .map(t => ({ type: t.taxNumberType?.code ?? undefined, number: t.taxNumber ?? undefined })),
    bankAccounts: r.bankAccounts
      ?.filter(b => b.IBAN || b.validFrom)
      .map(b => ({
        validFrom: b.validFrom ?? undefined,
        validTo:   b.validTo  ?? undefined,
        iban:      b.IBAN     ?? undefined,
        country:   b.bankCountry?.code ?? undefined,
      })),
    customFields: Object.keys(customFields).length ? customFields : undefined,
    realm: config.ARIBA_REALM,
  };
}

// NOTE: because these filters run client-side on a single page of results,
// totalCount/hasMore/pageToken below reflect the *server's* full result set,
// not the filtered subset — the filtered totalCount is only accurate for the
// current page. Good enough for a quick lookup tool; for exact totals you'd
// need to walk every page and filter as you go.
function filterVendors(result: VendorListResult, predicate: (v: Vendor) => boolean): VendorListResult {
  const vendors = result.vendors.filter(predicate);
  return { ...result, vendors, totalCount: vendors.length };
}

function mapVendorList(raw: AribaVendorListResponse): VendorListResult {
  return {
    vendors:    raw.map(mapVendor),
    totalCount: raw.length,
    pageToken:  undefined,
    hasMore:    false,
  };
}

function mapInactiveVendor(r: AribaInactiveVendorRaw): InactiveVendor {
  // name2/name3/name4 are overflow segments for long names — join non-null parts
  const nameParts = [r.supplierName, r.name2, r.name3, r.name4].filter(Boolean);
  return {
    vendorId:            r.smVendorId ?? "UNKNOWN",
    name:                nameParts.join(" ") || "Unknown",
    erpVendorId:         r.erpVendorId ?? undefined,
    acmId:               r.acmId ?? undefined,
    anId:                r.anId ?? undefined,
    registrationStatus:  r.registrationStatus ?? "UNKNOWN",
    qualificationStatus: r.qualificationStatus ?? undefined,
    erpIntStatus:        r.erpIntStatus ?? undefined,
    timeUpdated:         r.timeUpdated ?? undefined,
    timeCreated:         r.timeCreated ?? undefined,
    realm:               config.ARIBA_REALM,
  };
}