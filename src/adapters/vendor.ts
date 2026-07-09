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
  primaryAddress?:       VendorAddress;
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
  status?:     string;        // applied client-side (see listVendors)
  name?:       string;        // partial name search, applied client-side
  country?:    string;        // ISO-2 country code, applied client-side
  category?:   string;        // commodity category code, applied client-side
  vendorIds?:  string[];      // SM/ERP vendor IDs — sent to Ariba as smVendorIds
  pageToken?:  string;        // cursor from previous page
  pageSize?:   number;        // 1–100, default from config
}

// ── Infrastructure ─────────────────────────────────────────────────────────────

const breaker = new CircuitBreaker({
  name:              "Ariba-VendorAPI",
  timeout:           12_000,
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
      // The documented vendorDataRequests body schema takes outputFormat,
      // pageLimit, withQuestionnaire/withBankDetail/etc, and optional
      // smVendorIds / erpVendorIds filter lists (comma-separated strings).
      // It does NOT document filtering by free-text name/status/country/category —
      // those are applied client-side below, after the page is fetched.
      const body: Record<string, unknown> = {
        outputFormat:      "JSON",
        pageLimit:         params.pageSize ?? config.DEFAULT_PAGE_SIZE,
        withQuestionnaire: true,
      };

      if (params.vendorIds?.length) {
        body.smVendorIds = params.vendorIds.join(",");
      }
      if (params.pageToken) {
        // NOTE: confirm the exact continuation-token field name against a
        // real response from your tenant (e.g. it may be "nextPageToken" on
        // the request side too, or pagination may be request/poll based).
        body.pageToken = params.pageToken;
      }

      const raw = await aribaFetch(
        "/api/supplierdatapagination/v4/prod/vendorDataRequests",
        { method: "POST", jsonBody: body },
      ) as AribaVendorListResponse;

      let result = mapVendorList(raw);

      // Client-side filtering for fields the API itself doesn't filter on.
      if (params.status)   result = filterVendors(result, v => v.registrationStatus === params.status);
      if (params.country)  result = filterVendors(result, v => v.primaryAddress?.country === params.country);
      if (params.category) result = filterVendors(result, v =>
        (v.qualifications ?? []).some(q => q.category === params.category));
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
      ) as AribaVendorResponse;

      return mapVendor(raw);
    });
  }

  async searchVendorsByName(name: string, pageSize?: number): Promise<VendorListResult> {
    return this.listVendors({ name, pageSize });
  }

  async getActiveVendors(country?: string, pageSize?: number): Promise<VendorListResult> {
    return this.listVendors({ status: "ACTIVE", country, pageSize });
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

type AribaVendorResponse = AribaVendorRaw;

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