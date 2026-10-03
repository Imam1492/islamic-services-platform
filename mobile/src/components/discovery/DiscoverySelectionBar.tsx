import React, { useState, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  Modal,
  FlatList,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import type { ResolvedArea, CategoryWithServices, CatalogService } from '../../types/catalog';

export interface DiscoverySelectionBarProps {
  selectedArea: ResolvedArea | null;
  selectedService: CatalogService | null;
  areas: ResolvedArea[];
  categoriesWithServices: CategoryWithServices[];
  onSelectArea: (area: ResolvedArea) => void;
  onSelectService: (service: CatalogService) => void;
  isLoadingCatalog?: boolean;
}

export function DiscoverySelectionBar({
  selectedArea,
  selectedService,
  areas,
  categoriesWithServices,
  onSelectArea,
  onSelectService,
  isLoadingCatalog = false,
}: DiscoverySelectionBarProps) {
  const [isAreaModalVisible, setIsAreaModalVisible] = useState(false);
  const [isServiceModalVisible, setIsServiceModalVisible] = useState(false);
  const [areaSearch, setAreaSearch] = useState('');
  const [serviceSearch, setServiceSearch] = useState('');

  // Filtered areas based on user search query
  const filteredAreas = useMemo(() => {
    const query = areaSearch.trim().toLowerCase();
    if (!query) return areas;
    return areas.filter(
      (a) =>
        a.name.toLowerCase().includes(query) ||
        a.cityName.toLowerCase().includes(query) ||
        a.stateName.toLowerCase().includes(query) ||
        a.countryName.toLowerCase().includes(query)
    );
  }, [areas, areaSearch]);

  // Filtered categories and services based on user search query
  const filteredCategories = useMemo(() => {
    const query = serviceSearch.trim().toLowerCase();
    if (!query) return categoriesWithServices;
    return categoriesWithServices
      .map((cat) => ({
        ...cat,
        services: cat.services.filter(
          (s) => s.name.toLowerCase().includes(query) || cat.name.toLowerCase().includes(query)
        ),
      }))
      .filter((cat) => cat.services.length > 0);
  }, [categoriesWithServices, serviceSearch]);

  const handleSelectArea = (area: ResolvedArea) => {
    onSelectArea(area);
    setIsAreaModalVisible(false);
    setAreaSearch('');
  };

  const handleSelectService = (service: CatalogService) => {
    onSelectService(service);
    setIsServiceModalVisible(false);
    setServiceSearch('');
  };

  return (
    <View style={styles.container} testID="discovery-selection-bar">
      {/* Area Selector Card */}
      <Pressable
        style={styles.selectorCard}
        onPress={() => setIsAreaModalVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={
          selectedArea ? `Selected area: ${selectedArea.fullName}` : 'Select an area'
        }
        testID="area-selector-button"
      >
        <View style={styles.iconWrapper}>
          <Text style={styles.icon}>📍</Text>
        </View>
        <View style={styles.textContainer} testID="discover-location-placeholder">
          <Text style={styles.label}>AREA</Text>
          <Text
            style={[styles.valueText, !selectedArea && styles.placeholderText]}
            numberOfLines={1}
            testID="area-selector-text"
          >
            {selectedArea ? selectedArea.fullName : 'Select an area'}
          </Text>
          {!selectedArea && (
            <Text style={styles.areaSubtext}>
              Choose your area when discovery is available.
            </Text>
          )}
        </View>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      {/* Service Selector Card */}
      <Pressable
        style={styles.selectorCard}
        onPress={() => setIsServiceModalVisible(true)}
        accessibilityRole="button"
        accessibilityLabel={
          selectedService ? `Selected service: ${selectedService.name}` : 'Select a service'
        }
        testID="service-selector-button"
      >
        <View style={[styles.iconWrapper, styles.serviceIconWrapper]}>
          <Text style={styles.icon}>💼</Text>
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.label}>SERVICE</Text>
          <Text
            style={[styles.valueText, !selectedService && styles.placeholderText]}
            numberOfLines={1}
            testID="service-selector-text"
          >
            {selectedService ? selectedService.name : 'Select a service'}
          </Text>
        </View>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      {/* Area Selection Modal */}
      <Modal
        visible={isAreaModalVisible}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setIsAreaModalVisible(false)}
        testID="area-selection-modal"
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select an Area</Text>
            <Pressable
              onPress={() => {
                setIsAreaModalVisible(false);
                setAreaSearch('');
              }}
              accessibilityRole="button"
              accessibilityLabel="Close area selection"
              style={styles.closeButton}
              testID="close-area-modal"
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </Pressable>
          </View>

          {/* Area Search Input */}
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search area, city, or state..."
              placeholderTextColor="#9CA3AF"
              value={areaSearch}
              onChangeText={setAreaSearch}
              testID="area-search-input"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {/* Hierarchy Explanation Note */}
          <View style={styles.hierarchyNote}>
            <Text style={styles.hierarchyNoteText}>
              Hierarchy: Country → State → City → Area
            </Text>
          </View>

          {isLoadingCatalog ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.loadingText}>Loading available locations...</Text>
            </View>
          ) : filteredAreas.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No matching areas found.</Text>
            </View>
          ) : (
            <FlatList
              data={filteredAreas}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item }) => {
                const isSelected = selectedArea?.id === item.id;
                return (
                  <Pressable
                    style={[styles.areaItem, isSelected && styles.selectedItem]}
                    onPress={() => handleSelectArea(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.name}, ${item.cityName}, ${item.stateName}, ${item.countryName}`}
                    testID={`area-item-${item.id}`}
                  >
                    <View style={styles.areaInfo}>
                      <Text style={[styles.areaName, isSelected && styles.selectedText]}>
                        {item.name}
                      </Text>
                      <Text style={styles.areaHierarchy}>
                        {item.cityName}, {item.stateName}, {item.countryName}
                      </Text>
                    </View>
                    {isSelected && <Text style={styles.checkmark}>✓</Text>}
                  </Pressable>
                );
              }}
            />
          )}
        </View>
      </Modal>

      {/* Service Selection Modal */}
      <Modal
        visible={isServiceModalVisible}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setIsServiceModalVisible(false)}
        testID="service-selection-modal"
      >
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select a Service</Text>
            <Pressable
              onPress={() => {
                setIsServiceModalVisible(false);
                setServiceSearch('');
              }}
              accessibilityRole="button"
              accessibilityLabel="Close service selection"
              style={styles.closeButton}
              testID="close-service-modal"
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </Pressable>
          </View>

          {/* Service Search Input */}
          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search services or categories..."
              placeholderTextColor="#9CA3AF"
              value={serviceSearch}
              onChangeText={setServiceSearch}
              testID="service-search-input"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          {isLoadingCatalog ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color="#2563EB" />
              <Text style={styles.loadingText}>Loading available services...</Text>
            </View>
          ) : filteredCategories.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No matching services found.</Text>
            </View>
          ) : (
            <FlatList
              data={filteredCategories}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.listContent}
              renderItem={({ item: category }) => (
                <View style={styles.categorySection}>
                  <Text style={styles.categoryHeader}>{category.name}</Text>
                  {category.services.map((service) => {
                    const isSelected = selectedService?.id === service.id;
                    return (
                      <Pressable
                        key={service.id}
                        style={[styles.serviceItem, isSelected && styles.selectedItem]}
                        onPress={() => handleSelectService(service)}
                        accessibilityRole="button"
                        accessibilityLabel={`${service.name}, category ${category.name}`}
                        testID={`service-item-${service.id}`}
                      >
                        <Text
                          style={[styles.serviceName, isSelected && styles.selectedText]}
                        >
                          {service.name}
                        </Text>
                        {isSelected && <Text style={styles.checkmark}>✓</Text>}
                      </Pressable>
                    );
                  })}
                </View>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
    gap: 10,
  },
  selectorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  iconWrapper: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#EFF6FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  serviceIconWrapper: {
    backgroundColor: '#F3F4F6',
  },
  icon: {
    fontSize: 18,
  },
  textContainer: {
    flex: 1,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  valueText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  placeholderText: {
    color: '#9CA3AF',
    fontWeight: '400',
  },
  areaSubtext: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  chevron: {
    fontSize: 16,
    color: '#9CA3AF',
    marginLeft: 8,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
    paddingTop: 50,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    color: '#4B5563',
    fontWeight: '600',
  },
  searchContainer: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  searchInput: {
    backgroundColor: '#F3F4F6',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
  },
  hierarchyNote: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: '#F3F4F6',
  },
  hierarchyNoteText: {
    fontSize: 12,
    color: '#6B7280',
    fontStyle: 'italic',
  },
  listContent: {
    padding: 16,
  },
  areaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 8,
  },
  areaInfo: {
    flex: 1,
  },
  areaName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  areaHierarchy: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  categorySection: {
    marginBottom: 16,
  },
  categoryHeader: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4B5563',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    paddingLeft: 4,
  },
  serviceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginBottom: 8,
  },
  serviceName: {
    fontSize: 15,
    fontWeight: '500',
    color: '#111827',
  },
  selectedItem: {
    borderColor: '#2563EB',
    backgroundColor: '#EFF6FF',
  },
  selectedText: {
    color: '#1D4ED8',
    fontWeight: '600',
  },
  checkmark: {
    fontSize: 16,
    color: '#2563EB',
    fontWeight: '700',
    marginLeft: 8,
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 14,
    color: '#6B7280',
  },
  emptyContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#6B7280',
  },
});
