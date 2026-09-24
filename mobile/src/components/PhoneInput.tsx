import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  Modal,
  FlatList,
} from 'react-native';
import {
  SUPPORTED_COUNTRIES,
  CountryCodeOption,
  cleanDigits,
} from '../utils/phone';

export interface PhoneInputProps {
  countryCode: string;
  onCountryCodeChange?: (countryCode: string) => void;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  onSubmitEditing?: () => void;
  testID?: string;
}

export function PhoneInput({
  countryCode,
  onCountryCodeChange,
  value,
  onChangeText,
  error,
  disabled = false,
  loading = false,
  placeholder = 'Enter mobile number',
  onSubmitEditing,
  testID = 'phone-input',
}: PhoneInputProps) {
  const [modalVisible, setModalVisible] = useState(false);

  const selectedCountry =
    SUPPORTED_COUNTRIES.find((c) => c.code === countryCode) ||
    SUPPORTED_COUNTRIES[0];

  const handleCountrySelect = (country: CountryCodeOption) => {
    onCountryCodeChange?.(country.code);
    setModalVisible(false);
  };

  const isInteractive = !disabled && !loading;

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label} nativeID="phone-input-label">
        Mobile Phone Number
      </Text>

      <View
        style={[
          styles.inputContainer,
          error ? styles.inputContainerError : null,
          !isInteractive ? styles.inputContainerDisabled : null,
        ]}
      >
        <Pressable
          style={styles.countryPickerButton}
          onPress={() => isInteractive && setModalVisible(true)}
          disabled={!isInteractive}
          accessibilityRole="button"
          accessibilityLabel={`Selected country ${selectedCountry.label}. Tap to change country.`}
          accessibilityHint="Opens country code selection list"
          testID={`${testID}-country-picker`}
        >
          <Text style={styles.countryFlag}>{selectedCountry.flag}</Text>
          <Text style={styles.countryCodeText}>{selectedCountry.code}</Text>
          <Text style={styles.chevron}>▾</Text>
        </Pressable>

        <View style={styles.divider} />

        <TextInput
          style={[styles.input, !isInteractive ? styles.inputDisabled : null]}
          value={value}
          onChangeText={(text) => {
            // Keep only digits in national number
            onChangeText(cleanDigits(text));
          }}
          keyboardType="phone-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          placeholder={placeholder}
          placeholderTextColor="#9CA3AF"
          editable={isInteractive}
          returnKeyType="done"
          onSubmitEditing={onSubmitEditing}
          accessibilityLabel="Mobile phone number input"
          accessibilityHint="Enter your 10-digit mobile number without country code"
          accessibilityState={{ disabled: !isInteractive }}
          aria-labelledby="phone-input-label"
          aria-invalid={!!error}
          aria-describedby={error ? 'phone-input-error' : undefined}
          testID={testID}
          maxLength={15}
        />
      </View>

      {error ? (
        <Text
          style={styles.errorText}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          nativeID="phone-input-error"
          testID={`${testID}-error`}
        >
          {error}
        </Text>
      ) : null}

      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setModalVisible(false)}
          accessibilityRole="button"
          accessibilityLabel="Close country selection"
        >
          <View
            style={styles.modalContent}
            onStartShouldSetResponder={() => true}
          >
            <Text style={styles.modalTitle}>Select Country</Text>
            <FlatList
              data={SUPPORTED_COUNTRIES}
              keyExtractor={(item) => item.code}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [
                    styles.countryRow,
                    item.code === selectedCountry.code
                      ? styles.countryRowSelected
                      : null,
                    pressed ? styles.countryRowPressed : null,
                  ]}
                  onPress={() => handleCountrySelect(item)}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  testID={`country-option-${item.iso.toLowerCase()}`}
                >
                  <Text style={styles.countryRowFlag}>{item.flag}</Text>
                  <Text style={styles.countryRowLabel}>{item.label}</Text>
                  {item.code === selectedCountry.code && (
                    <Text style={styles.checkmark}>✓</Text>
                  )}
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    height: 52,
    overflow: 'hidden',
  },
  inputContainerError: {
    borderColor: '#EF4444',
  },
  inputContainerDisabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#E5E7EB',
  },
  countryPickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: '100%',
    backgroundColor: '#F9FAFB',
  },
  countryFlag: {
    fontSize: 18,
    marginRight: 6,
  },
  countryCodeText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1F2937',
  },
  chevron: {
    fontSize: 12,
    color: '#6B7280',
    marginLeft: 4,
  },
  divider: {
    width: 1,
    height: '60%',
    backgroundColor: '#E5E7EB',
  },
  input: {
    flex: 1,
    height: '100%',
    paddingHorizontal: 12,
    fontSize: 16,
    color: '#111827',
  },
  inputDisabled: {
    color: '#9CA3AF',
  },
  errorText: {
    fontSize: 13,
    color: '#EF4444',
    marginTop: 6,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxHeight: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
    textAlign: 'center',
  },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  countryRowSelected: {
    backgroundColor: '#EEF2FF',
  },
  countryRowPressed: {
    backgroundColor: '#E0E7FF',
  },
  countryRowFlag: {
    fontSize: 20,
    marginRight: 10,
  },
  countryRowLabel: {
    fontSize: 15,
    color: '#1F2937',
    flex: 1,
  },
  checkmark: {
    fontSize: 16,
    fontWeight: '700',
    color: '#4F46E5',
  },
});
