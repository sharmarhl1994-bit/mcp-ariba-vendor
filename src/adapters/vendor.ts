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

export interface Vendor {
  vendorId:        string;
  name:            string;
  status:          string;
  type?:           string;
  taxId?:          string;
  dunsNumber?:     string;
  website?:        string;
  registeredDate?: string;
  primaryAddress?: VendorAddress;
  primaryContact?: VendorContact;
  categories?:     string[];
  realm:           string;
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
      if (params.status)   result = filterVendors(result, v => v.status === params.status);
      if (params.country)  result = filterVendors(result, v => v.primaryAddress?.country === params.country);
      if (params.category) result = filterVendors(result, v => (v.categories ?? []).includes(params.category!));
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
// Ariba OpenAPI v4 returns data wrapped in a "content" array with pagination metadata

interface AribaVendorRaw {
  vendorId?:          string;
  id?:                string;
  name?:              string;
  vendorName?:        string;
  status?:            string;
  vendorStatus?:      string;
  supplierType?:      string;
  taxId?:             string;
  dunsNumber?:        string;
  website?:           string;
  registrationDate?:  string;
  createdDate?:       string;
  address?: {
    addressLine1?: string;
    addressLine2?: string;
    city?:         string;
    state?:        string;
    postalCode?:   string;
    country?:      string;
  };
  contacts?: Array<{
    firstName?: string;
    lastName?:  string;
    email?:     string;
    phone?:     string;
    role?:      string;
  }>;
  commodityCategories?: string[];
  categories?:          string[];
}

interface AribaVendorListResponse {
  content?:       AribaVendorRaw[];
  data?:          AribaVendorRaw[];
  totalElements?: number;
  totalCount?:    number;
  nextPageToken?: string;
  pageToken?:     string;
  hasMore?:       boolean;
}

type AribaVendorResponse = AribaVendorRaw;

// ── Mappers ────────────────────────────────────────────────────────────────────

function mapVendor(r: AribaVendorRaw): Vendor {
  const primary = r.contacts?.[0];
  return {
    vendorId:        r.vendorId ?? r.id ?? "UNKNOWN",
    name:            r.name ?? r.vendorName ?? "Unknown",
    status:          r.status ?? r.vendorStatus ?? "UNKNOWN",
    type:            r.supplierType,
    taxId:           r.taxId,
    dunsNumber:      r.dunsNumber,
    website:         r.website,
    registeredDate:  r.registrationDate ?? r.createdDate,
    primaryAddress:  r.address
      ? {
          addressLine1: r.address.addressLine1,
          addressLine2: r.address.addressLine2,
          city:         r.address.city,
          state:        r.address.state,
          postalCode:   r.address.postalCode,
          country:      r.address.country,
        }
      : undefined,
    primaryContact: primary
      ? {
          firstName: primary.firstName,
          lastName:  primary.lastName,
          email:     primary.email,
          phone:     primary.phone,
          role:      primary.role,
        }
      : undefined,
    categories: r.commodityCategories ?? r.categories,
    realm:      config.ARIBA_REALM,
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
  const items      = raw.content ?? raw.data ?? [];
  const totalCount = raw.totalElements ?? raw.totalCount ?? items.length;
  const pageToken  = raw.nextPageToken ?? raw.pageToken;
  const hasMore    = raw.hasMore ?? (pageToken != null && pageToken !== "");

  return {
    vendors:    items.map(mapVendor),
    totalCount,
    pageToken,
    hasMore,
  };
}