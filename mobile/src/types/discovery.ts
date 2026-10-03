/**
 * Canonical Discovery Types
 * Derived strictly from PostgreSQL Migration 02 and Migration 09 contracts.
 * Strictly public interface contracts.
 */

export type BadgeType =
  | 'identity_verified'
  | 'skill_verified'
  | 'community_vouched'
  | 'background_checked';

/**
 * PostgreSQL provider_gender enum strictly defined as ('male', 'female') in Migration 02.
 */
export type ProviderGender = 'male' | 'female';

export interface DiscoveryItem {
  provider_id: string;
  display_name: string;
  gender: ProviderGender;
  bio: string | null;
  years_experience: number;
  badges: BadgeType[];
}

export interface DiscoveryCursor {
  display_name: string;
  provider_id: string;
}

export interface DiscoveryResult {
  providers: DiscoveryItem[];
  has_more: boolean;
  next_cursor: DiscoveryCursor | null;
}

export interface DiscoveryFilters {
  areaId: string;
  serviceId: string;
  gender?: ProviderGender;
  minExperience?: number;
  requiredBadges?: BadgeType[];
  limit?: number;
}

export interface PublicProviderService {
  id: string;
  name: string;
  slug: string;
  category_id: string;
  category_name: string;
}

export interface PublicProviderArea {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface PublicProviderBadge {
  badge_type: BadgeType;
  granted_at: string;
}

export interface PublicProviderProfile {
  provider_id: string;
  display_name: string;
  gender: ProviderGender;
  bio: string | null;
  years_experience: number;
  services: PublicProviderService[];
  areas: PublicProviderArea[];
  badges: PublicProviderBadge[];
}

export type DiscoveryErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface DiscoveryServiceError {
  code: DiscoveryErrorCode;
  userMessage: string;
  sanitizedDetails?: string;
}
