import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useAuth } from '../../context/AuthContext';
import { useCatalog } from '../../hooks/useCatalog';
import { useProviderDiscovery } from '../../hooks/useProviderDiscovery';
import type { ResolvedArea, CatalogService } from '../../types/catalog';
import type {
  ProviderGender,
  BadgeType,
  DiscoveryFilters,
  DiscoveryItem,
} from '../../types/discovery';
import { DiscoverySelectionBar } from '../../components/discovery/DiscoverySelectionBar';
import { DiscoveryFilterBar } from '../../components/discovery/DiscoveryFilterBar';
import { DiscoveryFilterModal } from '../../components/discovery/DiscoveryFilterModal';
import { ProviderCard } from '../../components/discovery/ProviderCard';
import { PublicProviderProfileModal } from '../../components/discovery/PublicProviderProfileModal';

export function DiscoverShellScreen() {
  const { session } = useAuth();
  const isAuthenticated = Boolean(session?.user);

  // 1. Catalog Hook Integration
  const {
    areas,
    categoriesWithServices,
    isLoading: isLoadingCatalog,
    error: catalogError,
    refresh: refreshCatalog,
  } = useCatalog(isAuthenticated);

  // 2. DiscoverShellScreen Presentation State
  const [selectedArea, setSelectedArea] = useState<ResolvedArea | null>(null);
  const [selectedService, setSelectedService] = useState<CatalogService | null>(null);
  const [gender, setGender] = useState<ProviderGender | undefined>(undefined);
  const [minExperience, setMinExperience] = useState<number | undefined>(undefined);
  const [requiredBadges, setRequiredBadges] = useState<BadgeType[] | undefined>(undefined);
  const [isFilterModalVisible, setIsFilterModalVisible] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // 3. Derived Discovery Filters (strictly null until both Area and Service are selected)
  const discoveryFilters = useMemo<DiscoveryFilters | null>(() => {
    if (!selectedArea || !selectedService) {
      return null;
    }
    return {
      areaId: selectedArea.id,
      serviceId: selectedService.id,
      ...(gender ? { gender } : {}),
      ...(typeof minExperience === 'number' ? { minExperience } : {}),
      ...(requiredBadges && requiredBadges.length > 0 ? { requiredBadges } : {}),
      limit: 15,
    };
  }, [selectedArea, selectedService, gender, minExperience, requiredBadges]);

  // 4. Provider Discovery Hook Integration
  const {
    providers,
    hasMore,
    isLoading: isLoadingDiscovery,
    isRefreshing: isRefreshingDiscovery,
    isLoadingMore,
    error: discoveryError,
    isEmpty,
    setFilters,
    refresh: refreshDiscovery,
    loadMore,
  } = useProviderDiscovery(null, isAuthenticated);

  // Synchronize discovery filters when Area/Service/Optional filters change
  useEffect(() => {
    setFilters(discoveryFilters);
  }, [discoveryFilters, setFilters]);

  // Active filter count (excluding area & service which are mandatory selections)
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (gender !== undefined) count++;
    if (typeof minExperience === 'number' && minExperience > 0) count++;
    if (requiredBadges && requiredBadges.length > 0) count += requiredBadges.length;
    return count;
  }, [gender, minExperience, requiredBadges]);

  const handleClearFilters = useCallback(() => {
    setGender(undefined);
    setMinExperience(undefined);
    setRequiredBadges(undefined);
  }, []);

  const handleApplyFilters = useCallback(
    (newFilters: {
      gender?: ProviderGender;
      minExperience?: number;
      requiredBadges?: BadgeType[];
    }) => {
      setGender(newFilters.gender);
      setMinExperience(newFilters.minExperience);
      setRequiredBadges(newFilters.requiredBadges);
    },
    []
  );

  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore && !isLoadingDiscovery) {
      void loadMore();
    }
  }, [hasMore, isLoadingMore, isLoadingDiscovery, loadMore]);

  const handleRefresh = useCallback(async () => {
    if (selectedArea && selectedService) {
      await refreshDiscovery();
    } else {
      await refreshCatalog();
    }
  }, [selectedArea, selectedService, refreshDiscovery, refreshCatalog]);

  const renderProviderItem = useCallback(
    ({ item }: { item: DiscoveryItem }) => (
      <ProviderCard
        provider={item}
        onPress={(id) => setSelectedProfileId(id)}
      />
    ),
    []
  );

  // List Header Component
  const renderHeader = useMemo(
    () => (
      <View style={styles.headerContainer}>
        {/* Screen Header */}
        <View style={styles.header}>
          <Text style={styles.screenTitle} testID="discover-screen-title">
            Discover
          </Text>
          <Text style={styles.screenSubtitle}>
            Find local services and trusted community providers
          </Text>
        </View>

        {/* Catalog Error Banner */}
        {catalogError && (
          <View style={styles.catalogErrorBanner} testID="catalog-error-banner">
            <Text style={styles.catalogErrorText}>{catalogError.userMessage}</Text>
            <Pressable
              style={styles.catalogRetryButton}
              onPress={() => void refreshCatalog()}
              accessibilityRole="button"
              accessibilityLabel="Retry loading catalog"
              testID="catalog-retry-button"
            >
              <Text style={styles.catalogRetryButtonText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* Mandatory Area & Service Selection Bar */}
        <DiscoverySelectionBar
          selectedArea={selectedArea}
          selectedService={selectedService}
          areas={areas}
          categoriesWithServices={categoriesWithServices}
          onSelectArea={(area) => setSelectedArea(area)}
          onSelectService={(service) => setSelectedService(service)}
          isLoadingCatalog={isLoadingCatalog}
        />

        {/* Optional Filter Controls (visible only after Area + Service are chosen) */}
        {selectedArea && selectedService && (
          <DiscoveryFilterBar
            activeFilterCount={activeFilterCount}
            onPressFilters={() => setIsFilterModalVisible(true)}
            onClearFilters={handleClearFilters}
            gender={gender}
            minExperience={minExperience}
            requiredBadges={requiredBadges}
          />
        )}
      </View>
    ),
    [
      catalogError,
      refreshCatalog,
      selectedArea,
      selectedService,
      areas,
      categoriesWithServices,
      isLoadingCatalog,
      activeFilterCount,
      handleClearFilters,
      gender,
      minExperience,
      requiredBadges,
    ]
  );

  // List Empty Component
  const renderEmpty = useMemo(() => {
    if (isLoadingCatalog) {
      return (
        <View style={styles.centerState} testID="catalog-loading-indicator">
          <ActivityIndicator size="small" color="#2563EB" />
          <Text style={styles.stateSubtitle}>Loading service catalog...</Text>
        </View>
      );
    }

    if (!selectedArea || !selectedService) {
      return (
        <View style={styles.placeholderCard} testID="awaiting-selection-message">
          <View style={styles.placeholderIconWrapper}>
            <Text style={styles.placeholderIcon}>🔍</Text>
          </View>
          <Text style={styles.placeholderTitle}>Select an Area & Service</Text>
          <Text style={styles.placeholderBody}>
            Choose your location and desired service category above to discover verified, local
            community providers.
          </Text>
          <View style={styles.searchBarPlaceholder} testID="discover-search-placeholder">
            <Text style={styles.searchIcon}>🔍</Text>
            <Text style={styles.searchPlaceholderText}>Search services or providers...</Text>
          </View>
        </View>
      );
    }

    if (isLoadingDiscovery) {
      return (
        <View style={styles.centerState} testID="discovery-loading-indicator">
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.stateSubtitle}>Searching verified providers...</Text>
        </View>
      );
    }

    if (discoveryError) {
      return (
        <View style={styles.centerState} testID="discovery-error-state">
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorTitle}>Unable to load providers</Text>
          <Text style={styles.errorText} testID="discovery-error-message">
            {discoveryError.userMessage}
          </Text>
          <Pressable
            style={styles.retryButton}
            onPress={() => void refreshDiscovery()}
            accessibilityRole="button"
            accessibilityLabel="Retry provider search"
            testID="discovery-retry-button"
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      );
    }

    if (isEmpty) {
      return (
        <View style={styles.centerState} testID="discovery-empty-state">
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyTitle}>No Providers Found</Text>
          <Text style={styles.emptyText}>
            No verified providers found matching your criteria in this area.
          </Text>
          {activeFilterCount > 0 && (
            <Pressable
              style={styles.resetFiltersButton}
              onPress={handleClearFilters}
              accessibilityRole="button"
              accessibilityLabel="Reset optional filters"
              testID="empty-clear-filters-button"
            >
              <Text style={styles.resetFiltersButtonText}>Reset filters</Text>
            </Pressable>
          )}
        </View>
      );
    }

    return null;
  }, [
    isLoadingCatalog,
    selectedArea,
    selectedService,
    isLoadingDiscovery,
    discoveryError,
    refreshDiscovery,
    isEmpty,
    activeFilterCount,
    handleClearFilters,
  ]);

  // List Footer Component
  const renderFooter = useMemo(() => {
    if (isLoadingMore) {
      return (
        <View style={styles.footerLoading} testID="discovery-loading-more-indicator">
          <ActivityIndicator size="small" color="#2563EB" />
          <Text style={styles.footerLoadingText}>Loading more providers...</Text>
        </View>
      );
    }
    return null;
  }, [isLoadingMore]);

  return (
    <View style={styles.container} testID="discover-shell-screen">
      <FlatList
        data={providers}
        keyExtractor={(item) => item.provider_id}
        renderItem={renderProviderItem}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={renderFooter}
        contentContainerStyle={styles.listContent}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshingDiscovery}
            onRefresh={() => void handleRefresh()}
          />
        }
      />

      {/* Filter Modal */}
      <DiscoveryFilterModal
        key={`filter-modal-${isFilterModalVisible}-${gender}-${minExperience}-${requiredBadges?.join(',')}`}
        visible={isFilterModalVisible}
        onClose={() => setIsFilterModalVisible(false)}
        initialGender={gender}
        initialMinExperience={minExperience}
        initialRequiredBadges={requiredBadges}
        onApply={handleApplyFilters}
        onClear={handleClearFilters}
      />

      {/* Public Provider Profile Modal */}
      <PublicProviderProfileModal
        providerId={selectedProfileId}
        visible={selectedProfileId !== null}
        onClose={() => setSelectedProfileId(null)}
        isAuthenticated={isAuthenticated}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  listContent: {
    padding: 20,
    paddingBottom: 40,
  },
  headerContainer: {
    marginBottom: 8,
  },
  header: {
    marginBottom: 20,
  },
  screenTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 4,
  },
  screenSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
  },
  catalogErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FCA5A5',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  catalogErrorText: {
    flex: 1,
    fontSize: 13,
    color: '#B91C1C',
    marginRight: 8,
  },
  catalogRetryButton: {
    backgroundColor: '#DC2626',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  catalogRetryButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  placeholderCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 24,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    marginTop: 12,
  },
  placeholderIconWrapper: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  placeholderIcon: {
    fontSize: 22,
  },
  placeholderTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 8,
    textAlign: 'center',
  },
  placeholderBody: {
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 22,
    textAlign: 'center',
  },
  centerState: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateSubtitle: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  errorIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },
  errorText: {
    fontSize: 14,
    color: '#DC2626',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  retryButton: {
    backgroundColor: '#2563EB',
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 10,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  resetFiltersButton: {
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
  },
  resetFiltersButtonText: {
    fontSize: 13,
    color: '#4B5563',
    fontWeight: '600',
  },
  footerLoading: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  footerLoadingText: {
    fontSize: 13,
    color: '#6B7280',
  },
  searchBarPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginTop: 16,
    width: '100%',
  },
  searchIcon: {
    fontSize: 16,
    marginRight: 10,
    opacity: 0.5,
  },
  searchPlaceholderText: {
    fontSize: 14,
    color: '#9CA3AF',
  },
});

