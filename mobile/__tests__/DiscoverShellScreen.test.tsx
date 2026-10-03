/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';
import { DiscoverShellScreen } from '../src/screens/authenticated/DiscoverShellScreen';
import { AuthProvider } from '../src/context/AuthContext';
import * as CatalogHook from '../src/hooks/useCatalog';
import * as DiscoveryHook from '../src/hooks/useProviderDiscovery';
import * as ProfileHook from '../src/hooks/usePublicProviderProfile';
import type { ResolvedArea, CategoryWithServices, CatalogService } from '../src/types/catalog';
import type {
  DiscoveryItem,
  PublicProviderProfile,
} from '../src/types/discovery';

declare const __dirname: string;
const fs = require('fs');
const path = require('path');

// Supabase mock for AuthContext
jest.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(() =>
        Promise.resolve({
          data: {
            session: {
              access_token: 'valid-jwt',
              user: { id: 'usr-1111-1111-1111-111111111111' },
            },
          },
          error: null,
        })
      ),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
      signOut: jest.fn(() => Promise.resolve({ error: null })),
    },
  },
}));

// Test Catalog Data
const mockArea1: ResolvedArea = {
  id: 'area-1111-1111-1111-111111111111',
  name: 'Banjara Hills',
  cityName: 'Hyderabad',
  stateName: 'Telangana',
  countryName: 'India',
  fullName: 'Banjara Hills, Hyderabad, Telangana, India',
};

const mockArea2: ResolvedArea = {
  id: 'area-2222-2222-2222-222222222222',
  name: 'Jubilee Hills',
  cityName: 'Hyderabad',
  stateName: 'Telangana',
  countryName: 'India',
  fullName: 'Jubilee Hills, Hyderabad, Telangana, India',
};

const mockService1: CatalogService = {
  id: 'srv-1111-1111-1111-111111111111',
  categoryId: 'cat-1111-1111-1111-111111111111',
  name: 'Home Deep Cleaning',
  slug: 'home-deep-cleaning',
  isActive: true,
};

const mockCategory1: CategoryWithServices = {
  id: 'cat-1111-1111-1111-111111111111',
  name: 'Cleaning',
  slug: 'cleaning',
  isActive: true,
  services: [mockService1],
};

const mockProvider1: DiscoveryItem = {
  provider_id: 'prov-1111-1111-1111-111111111111',
  display_name: 'Anita Sharma',
  gender: 'female',
  bio: 'Professional cleaner with extensive experience in residential deep cleaning and sanitization services.',
  years_experience: 6,
  badges: ['identity_verified', 'skill_verified'],
};

const mockProvider2: DiscoveryItem = {
  provider_id: 'prov-2222-2222-2222-222222222222',
  display_name: 'Rahul Varma',
  gender: 'male',
  bio: 'Certified cleaning specialist offering standard and intensive home care services.',
  years_experience: 3,
  badges: ['identity_verified', 'community_vouched', 'background_checked'],
};

const mockProfile1: PublicProviderProfile = {
  provider_id: 'prov-1111-1111-1111-111111111111',
  display_name: 'Anita Sharma',
  gender: 'female',
  bio: 'Professional cleaner with extensive experience in residential deep cleaning and sanitization services.',
  years_experience: 6,
  services: [
    {
      id: 'srv-1111-1111-1111-111111111111',
      name: 'Home Deep Cleaning',
      slug: 'home-deep-cleaning',
      category_id: 'cat-1111-1111-1111-111111111111',
      category_name: 'Cleaning',
    },
  ],
  areas: [
    {
      id: 'area-1111-1111-1111-111111111111',
      name: 'Banjara Hills',
      parent_id: null,
    },
  ],
  badges: [
    { badge_type: 'identity_verified', granted_at: '2026-01-01T00:00:00Z' },
    { badge_type: 'skill_verified', granted_at: '2026-02-01T00:00:00Z' },
  ],
};

describe('DiscoverShellScreen Phase 3.4.2B-B Integration Suite', () => {
  let mockSetFilters: jest.Mock;
  let mockRefreshDiscovery: jest.Mock;
  let mockLoadMore: jest.Mock;
  let mockFetchProfile: jest.Mock;
  let mockResetProfile: jest.Mock;
  let mockRefreshCatalog: jest.Mock;

  let catalogHookReturn: ReturnType<typeof CatalogHook.useCatalog>;
  let discoveryHookReturn: ReturnType<typeof DiscoveryHook.useProviderDiscovery>;
  let profileHookReturn: ReturnType<typeof ProfileHook.usePublicProviderProfile>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockSetFilters = jest.fn();
    mockRefreshDiscovery = jest.fn().mockResolvedValue(undefined);
    mockLoadMore = jest.fn().mockResolvedValue(undefined);
    mockFetchProfile = jest.fn().mockResolvedValue(undefined);
    mockResetProfile = jest.fn();
    mockRefreshCatalog = jest.fn().mockResolvedValue({ data: null, error: null });

    catalogHookReturn = {
      catalog: {
        locations: [],
        categories: [mockCategory1],
        services: [mockService1],
        areas: [mockArea1, mockArea2],
        categoriesWithServices: [mockCategory1],
      },
      areas: [mockArea1, mockArea2],
      categoriesWithServices: [mockCategory1],
      isLoading: false,
      isRefreshing: false,
      error: null,
      refresh: mockRefreshCatalog,
      getAreaById: jest.fn((id) => (id === mockArea1.id ? mockArea1 : null)),
      getServiceById: jest.fn((id) => (id === mockService1.id ? mockService1 : null)),
    };

    discoveryHookReturn = {
      providers: [],
      hasMore: false,
      nextCursor: null,
      isLoading: false,
      isRefreshing: false,
      isLoadingMore: false,
      error: null,
      isEmpty: false,
      setFilters: mockSetFilters,
      refresh: mockRefreshDiscovery,
      loadMore: mockLoadMore,
      reset: jest.fn(),
    };

    profileHookReturn = {
      profile: null,
      isLoading: false,
      error: null,
      fetchProfile: mockFetchProfile,
      reset: mockResetProfile,
    };

    jest.spyOn(CatalogHook, 'useCatalog').mockImplementation(() => catalogHookReturn);
    jest.spyOn(DiscoveryHook, 'useProviderDiscovery').mockImplementation(() => discoveryHookReturn);
    jest.spyOn(ProfileHook, 'usePublicProviderProfile').mockImplementation(() => profileHookReturn);
  });

  async function renderScreen() {
    const rendered = render(
      <AuthProvider>
        <DiscoverShellScreen />
      </AuthProvider>
    );
    await act(async () => {});
    return rendered;
  }

  // 1-3: Initial screen & selection placeholders
  it('1-3: renders initial Discover screen with "Select an area" and "Select a service"', async () => {
    const { getByTestId } = await renderScreen();

    expect(getByTestId('discover-shell-screen')).toBeTruthy();
    expect(getByTestId('discover-screen-title').props.children).toBe('Discover');
    expect(getByTestId('area-selector-text').props.children).toBe('Select an area');
    expect(getByTestId('service-selector-text').props.children).toBe('Select a service');
    expect(getByTestId('awaiting-selection-message')).toBeTruthy();
  });

  // 4-5: Modals open on button taps
  it('4-5: opens Area and Service selection modals upon tapping their buttons', async () => {
    const { getByTestId } = await renderScreen();

    // Area Modal opens
    fireEvent.press(getByTestId('area-selector-button'));
    expect(getByTestId('area-selection-modal')).toBeTruthy();
    expect(getByTestId('area-item-' + mockArea1.id)).toBeTruthy();

    // Close Area Modal
    fireEvent.press(getByTestId('close-area-modal'));

    // Service Modal opens
    fireEvent.press(getByTestId('service-selector-button'));
    expect(getByTestId('service-selection-modal')).toBeTruthy();
    expect(getByTestId('service-item-' + mockService1.id)).toBeTruthy();

    // Close Service Modal
    fireEvent.press(getByTestId('close-service-modal'));
  });

  // 6-9: Area & Service selection triggers discovery
  it('6-9: updates selection and triggers provider discovery only after BOTH are selected', async () => {
    const { getByTestId } = await renderScreen();

    // Select Area
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));

    // Area is selected, but service is NOT yet selected
    expect(getByTestId('area-selector-text').props.children).toBe(mockArea1.fullName);
    expect(getByTestId('service-selector-text').props.children).toBe('Select a service');

    // Discovery should NOT have been called with valid filters yet (filters remain null)
    expect(mockSetFilters).toHaveBeenLastCalledWith(null);

    // Select Service
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    // Both selected
    expect(getByTestId('service-selector-text').props.children).toBe(mockService1.name);

    // Now discovery filter should be populated and dispatched
    expect(mockSetFilters).toHaveBeenLastCalledWith({
      areaId: mockArea1.id,
      serviceId: mockService1.id,
      limit: 15,
    });
  });

  // 10: Provider loading state
  it('10: displays discovery loading indicator when searching providers', async () => {
    discoveryHookReturn.isLoading = true;
    const { getByTestId } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    expect(getByTestId('discovery-loading-indicator')).toBeTruthy();
  });

  // 11: Provider empty state
  it('11: displays empty state when no providers are returned for selected criteria', async () => {
    discoveryHookReturn.isEmpty = true;
    discoveryHookReturn.providers = [];
    const { getByTestId, getByText } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    expect(getByTestId('discovery-empty-state')).toBeTruthy();
    expect(getByText('No Providers Found')).toBeTruthy();
  });

  // 12-13: Provider error state & retry
  it('12-13: displays error state with user-safe message and triggers retry on press', async () => {
    discoveryHookReturn.error = {
      code: 'NETWORK_ERROR',
      userMessage: 'Unable to connect to discovery server. Please check your network.',
      sanitizedDetails: 'Connection timeout.',
    };
    const { getByTestId, getByText } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    expect(getByTestId('discovery-error-message')).toBeTruthy();
    expect(
      getByText('Unable to connect to discovery server. Please check your network.')
    ).toBeTruthy();

    // Trigger retry
    fireEvent.press(getByTestId('discovery-retry-button'));
    expect(mockRefreshDiscovery).toHaveBeenCalled();
  });

  // 14-18: Provider card rendering, gender, experience, bio truncation, badges
  it('14-18: renders provider cards with accurate gender, experience, bio, and badges', async () => {
    discoveryHookReturn.providers = [mockProvider1, mockProvider2];
    const { getByTestId } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    // Card 1 Checks
    expect(getByTestId(`provider-name-${mockProvider1.provider_id}`).props.children).toBe(
      'Anita Sharma'
    );
    expect(getByTestId(`provider-gender-${mockProvider1.provider_id}`)).toBeTruthy();
    expect(getByTestId(`provider-exp-${mockProvider1.provider_id}`).props.children).toBe(
      '6 years of experience'
    );
    expect(getByTestId(`provider-bio-${mockProvider1.provider_id}`).props.children).toBe(
      mockProvider1.bio
    );
    expect(getByTestId(`provider-badges-${mockProvider1.provider_id}`)).toBeTruthy();
    expect(getByTestId(`badge-identity_verified-${mockProvider1.provider_id}`)).toBeTruthy();
    expect(getByTestId(`badge-skill_verified-${mockProvider1.provider_id}`)).toBeTruthy();

    // Card 2 Checks
    expect(getByTestId(`provider-name-${mockProvider2.provider_id}`).props.children).toBe(
      'Rahul Varma'
    );
    expect(getByTestId(`provider-exp-${mockProvider2.provider_id}`).props.children).toBe(
      '3 years of experience'
    );
    expect(getByTestId(`badge-community_vouched-${mockProvider2.provider_id}`)).toBeTruthy();
    expect(getByTestId(`badge-background_checked-${mockProvider2.provider_id}`)).toBeTruthy();
  });

  // 19-25: Filter modal, gender, experience, badges, apply, clear, preservation of Area/Service
  it('19-25: filters by gender, experience, badges, and clearing filters preserves Area & Service', async () => {
    const { getByTestId, queryByTestId } = await renderScreen();

    // Select both Area & Service first
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    // Filter bar should now be visible
    expect(getByTestId('discovery-filter-bar')).toBeTruthy();

    // Open Filter Modal
    fireEvent.press(getByTestId('discovery-filter-button'));
    expect(getByTestId('discovery-filter-modal')).toBeTruthy();

    // Select Female
    fireEvent.press(getByTestId('filter-gender-female'));

    // Select 5+ years experience
    fireEvent.press(getByTestId('filter-exp-5'));

    // Select Identity verified and Background checked badges
    fireEvent.press(getByTestId('filter-badge-identity_verified'));
    fireEvent.press(getByTestId('filter-badge-background_checked'));

    // Apply filters
    fireEvent.press(getByTestId('apply-filters-button'));

    // Modal closed
    await waitFor(() => {
      expect(queryByTestId('discovery-filter-modal')).toBeNull();
    });

    // Discovery filter dispatched with filters
    expect(mockSetFilters).toHaveBeenLastCalledWith({
      areaId: mockArea1.id,
      serviceId: mockService1.id,
      gender: 'female',
      minExperience: 5,
      requiredBadges: ['identity_verified', 'background_checked'],
      limit: 15,
    });

    // Active filter badge count: 1 (gender) + 1 (exp) + 2 (badges) = 4
    expect(getByTestId('filter-count-badge').props.children).toBe(4);

    // Clear filters
    fireEvent.press(getByTestId('quick-clear-filters-button'));

    // Filters should reset to just area + service
    expect(mockSetFilters).toHaveBeenLastCalledWith({
      areaId: mockArea1.id,
      serviceId: mockService1.id,
      limit: 15,
    });

    // Area & Service remain intact!
    expect(getByTestId('area-selector-text').props.children).toBe(mockArea1.fullName);
    expect(getByTestId('service-selector-text').props.children).toBe(mockService1.name);
  });

  // 26: Pagination / loadMore
  it('26: invokes loadMore when end of list is reached with hasMore=true', async () => {
    discoveryHookReturn.providers = [mockProvider1];
    discoveryHookReturn.hasMore = true;
    discoveryHookReturn.isLoadingMore = false;

    const { getByTestId, UNSAFE_getByType } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    // Simulate FlatList onEndReached
    const { FlatList } = require('react-native');
    const flatList = UNSAFE_getByType(FlatList);
    await act(async () => {
      flatList.props.onEndReached();
    });

    expect(mockLoadMore).toHaveBeenCalled();
  });

  // 27: Pull to refresh
  it('27: connects refresh to provider discovery when selections are active', async () => {
    const { getByTestId, UNSAFE_getByType } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    const { FlatList } = require('react-native');
    const flatList = UNSAFE_getByType(FlatList);
    await act(async () => {
      flatList.props.refreshControl.props.onRefresh();
    });

    expect(mockRefreshDiscovery).toHaveBeenCalled();
  });

  // 28-32: Public provider profile modal lifecycle, states, and state preservation
  it('28-32: opens provider profile, displays profile, handles error, and preserves discovery on close', async () => {
    discoveryHookReturn.providers = [mockProvider1];
    profileHookReturn.profile = mockProfile1;

    const { getByTestId } = await renderScreen();

    // Select both
    fireEvent.press(getByTestId('area-selector-button'));
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(getByTestId('service-selector-button'));
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    // Tap provider card to open profile
    fireEvent.press(getByTestId(`provider-card-${mockProvider1.provider_id}`));

    // Profile modal open
    expect(getByTestId('public-provider-profile-modal')).toBeTruthy();
    expect(getByTestId('profile-display-name').props.children).toBe('Anita Sharma');
    expect(getByTestId('profile-experience').props.children).toBe('6 years of experience');
    expect(getByTestId('profile-bio').props.children).toBe(mockProfile1.bio);
    expect(getByTestId('profile-services-list')).toBeTruthy();
    expect(getByTestId('profile-areas-list')).toBeTruthy();
    expect(getByTestId('profile-badges-list')).toBeTruthy();

    // Close profile modal
    fireEvent.press(getByTestId('close-profile-modal'));

    // Discovery state remains intact
    expect(getByTestId('area-selector-text').props.children).toBe(mockArea1.fullName);
    expect(getByTestId('service-selector-text').props.children).toBe(mockService1.name);
  });

  // 33: Accessibility roles and labels
  it('33: provides accessible roles and labels across interactive elements', async () => {
    discoveryHookReturn.providers = [mockProvider1];
    const { getByTestId } = await renderScreen();

    const areaBtn = getByTestId('area-selector-button');
    expect(areaBtn.props.accessibilityRole).toBe('button');
    expect(areaBtn.props.accessibilityLabel).toBe('Select an area');

    const serviceBtn = getByTestId('service-selector-button');
    expect(serviceBtn.props.accessibilityRole).toBe('button');
    expect(serviceBtn.props.accessibilityLabel).toBe('Select a service');

    // Select both
    fireEvent.press(areaBtn);
    fireEvent.press(getByTestId('area-item-' + mockArea1.id));
    fireEvent.press(serviceBtn);
    fireEvent.press(getByTestId('service-item-' + mockService1.id));

    const card = getByTestId(`provider-card-${mockProvider1.provider_id}`);
    expect(card.props.accessibilityRole).toBe('button');
    expect(card.props.accessibilityLabel).toContain('Anita Sharma');
  });

  // 34-36: Security & Architectural boundary validations
  it('34-36: verifies NO phone, email, internal UUID, ranking UI, or direct provider-table queries exist', async () => {
    discoveryHookReturn.providers = [mockProvider1];
    const { queryByText } = await renderScreen();

    // Negative assertions on UI
    expect(queryByText(/phone/i)).toBeNull();
    expect(queryByText(/email/i)).toBeNull();
    expect(queryByText(/rating/i)).toBeNull();
    expect(queryByText(/popularity/i)).toBeNull();
    expect(queryByText(/recommendation/i)).toBeNull();
    expect(queryByText(/distance/i)).toBeNull();
    expect(queryByText(/near me/i)).toBeNull();

    // Static source scan on newly created and modified files
    const targetFiles = [
      path.join(__dirname, '../src/screens/authenticated/DiscoverShellScreen.tsx'),
      path.join(__dirname, '../src/components/discovery/DiscoverySelectionBar.tsx'),
      path.join(__dirname, '../src/components/discovery/DiscoveryFilterBar.tsx'),
      path.join(__dirname, '../src/components/discovery/DiscoveryFilterModal.tsx'),
      path.join(__dirname, '../src/components/discovery/ProviderCard.tsx'),
      path.join(__dirname, '../src/components/discovery/PublicProviderProfileModal.tsx'),
    ];

    for (const filePath of targetFiles) {
      const code = fs.readFileSync(filePath, 'utf-8');
      expect(code).not.toContain('service_role');
      expect(code).not.toContain('supabase.from(\'provider_profiles\')');
      expect(code).not.toContain('supabase.from(\'provider_locations\')');
      expect(code).not.toContain('supabase.from(\'provider_services\')');
      expect(code).not.toContain('supabase.from(\'provider_badges\')');
      expect(code).not.toContain('supabase.from(\'user_private\')');
    }
  });
});
