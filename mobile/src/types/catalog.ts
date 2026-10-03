export type LocationLevel = 'country' | 'state' | 'city' | 'area';

export interface CatalogLocation {
  id: string;
  name: string;
  parentId: string | null;
  level: LocationLevel;
  isActive: boolean;
}

export interface CatalogCategory {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface CatalogService {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface ResolvedArea {
  id: string;
  name: string;
  cityName: string;
  stateName: string;
  countryName: string;
  fullName: string;
}

export interface CategoryWithServices extends CatalogCategory {
  services: CatalogService[];
}

export interface CatalogData {
  locations: CatalogLocation[];
  categories: CatalogCategory[];
  services: CatalogService[];
  areas: ResolvedArea[];
  categoriesWithServices: CategoryWithServices[];
}

export type CatalogErrorCode =
  | 'AUTH_REQUIRED'
  | 'NETWORK_ERROR'
  | 'DATABASE_ERROR'
  | 'UNKNOWN_ERROR';

export interface CatalogError {
  code: CatalogErrorCode;
  userMessage: string;
  sanitizedDetails?: string;
}

export interface CatalogResult<T = CatalogData> {
  data: T | null;
  error: CatalogError | null;
}
