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
  status?:    string;        // ACTIVE | INACTIVE | PENDING
  name?:      string;        // partial name search
  country?:   string;        // ISO-2 country code
  category?:  string;        // commodity category code
  pageToken?: string;        // cursor from previous page
  pageSize?:  number;        // 1–100, default from config
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

async function aribaFetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
  await rateLimiter.acquire();

  const token = await aribaTokens.getToken();

  // Ariba requires realm + passwordAdapter + user on every request
  const query = new URLSearchParams({
    realm:           config.ARIBA_REALM,
    passwordAdapter: config.ARIBA_PASSWORD_ADAPTER,
    user:            config.ARIBA_USER,
    ...params,
  });

  const url = `${config.ARIBA_BASE_URL}${path}?${query.toString()}`;

  logger.debug("Ariba API call", { path, params });

  const res = await fetch(url, {
    headers: {
      Authorization:  `Bearer ${token}`,
      "apikey":       config.ARIBA_API_KEY,
      Accept:         "application/json",
      "Content-Type": "application/json",
    },
  });

  if (res.status === 401) {
    // Token may have been revoked — invalidate cache and retry once
    aribaTokens.invalidate();
    const retryToken = await aribaTokens.getToken();

    const retryRes = await fetch(url, {
      headers: {
        Authorization:  `Bearer ${retryToken}`,
        "apikey":       config.ARIBA_API_KEY,
        Accept:         "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!retryRes.ok) {
      const body = await retryRes.text();
      logger.error("Ariba API error after token retry", { path, status: retryRes.status, body });
      throw new Error(`Ariba API request failed [${retryRes.status}]: ${body}`);
    }

    return retryRes.json();
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error("Ariba API error", { path, status: res.status, body });
    throw new Error(`Ariba API request failed [${res.status}]: ${body}`);
  }

  return res.json();
}

// ── Adapter ────────────────────────────────────────────────────────────────────

export class VendorAdapter {

  async listVendors(params: VendorSearchParams = {}): Promise<VendorListResult> {
    return breaker.call(async () => {
      const query: Record<string, string> = {
        pageSize: String(params.pageSize ?? config.DEFAULT_PAGE_SIZE),
      };

      if (params.status)    query["status"]    = params.status;
      if (params.name)      query["name"]      = params.name;
      if (params.country)   query["country"]   = params.country;
      if (params.category)  query["category"]  = params.category;
      if (params.pageToken) query["pageToken"] = params.pageToken;

      const raw = await aribaFetch(
        "/api/supplierdatapagination/v4/prod/vendorDataRequests",
        query,
      ) as AribaVendorListResponse;

      return mapVendorList(raw);
    });
  }

  async getVendor(vendorId: string): Promise<Vendor> {
    return breaker.call(async () => {
      const raw = await aribaFetch(
        `/api/supplierdatapagination/v4/prod/vendorDataRequests/${encodeURIComponent(vendorId)}`,
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
