import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { PhoneInput } from '../src/components/PhoneInput';
import { validatePhoneInput, toE164, cleanDigits } from '../src/utils/phone';

describe('Phone Utility & Input Validation', () => {
  it('cleans non-digit characters correctly', () => {
    expect(cleanDigits('98765-43210')).toBe('9876543210');
    expect(cleanDigits('(987) 654 3210')).toBe('9876543210');
    expect(cleanDigits('+91 98765 43210')).toBe('919876543210');
  });

  it('canonicalizes Indian numbers to E.164', () => {
    expect(toE164('+91', '9876543210')).toBe('+919876543210');
    // Trims leading 0 in Indian trunk dialing
    expect(toE164('+91', '09876543210')).toBe('+919876543210');
  });

  it('validates valid Indian numbers starting with 6, 7, 8, 9', () => {
    const validNumbers = ['9876543210', '8123456789', '7001122334', '6987654321'];
    for (const num of validNumbers) {
      const result = validatePhoneInput('+91', num);
      expect(result.isValid).toBe(true);
      expect(result.e164).toBe(`+91${num}`);
      expect(result.error).toBeUndefined();
    }
  });

  it('rejects malformed Indian numbers with invalid starting digit', () => {
    const result = validatePhoneInput('+91', '5123456789');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Indian mobile numbers must start with 6, 7, 8, or 9.');
  });

  it('rejects incomplete numbers', () => {
    const result = validatePhoneInput('+91', '98765');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter a valid 10-digit mobile number.');
  });

  it('rejects empty input', () => {
    const result = validatePhoneInput('+91', '');
    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Please enter your mobile phone number.');
  });

  it('validates international E.164 numbers', () => {
    const usResult = validatePhoneInput('+1', '4155552671');
    expect(usResult.isValid).toBe(true);
    expect(usResult.e164).toBe('+14155552671');

    const invalidShort = validatePhoneInput('+1', '123');
    expect(invalidShort.isValid).toBe(false);
  });
});

describe('<PhoneInput /> component', () => {
  it('renders with label, default country code, and accessible attributes', () => {
    const onChangeText = jest.fn();
    const { getByTestId, getByText } = render(
      <PhoneInput
        countryCode="+91"
        value=""
        onChangeText={onChangeText}
      />
    );

    expect(getByText('Mobile Phone Number')).toBeTruthy();
    expect(getByText('+91')).toBeTruthy();
    const input = getByTestId('phone-input');
    expect(input.props.accessibilityLabel).toBe('Mobile phone number input');
  });

  it('formats input and strips non-numeric characters on change', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = render(
      <PhoneInput
        countryCode="+91"
        value=""
        onChangeText={onChangeText}
      />
    );

    const input = getByTestId('phone-input');
    fireEvent.changeText(input, '987-654-3210');
    expect(onChangeText).toHaveBeenCalledWith('9876543210');
  });

  it('renders accessible error state when error prop is provided', () => {
    const { getByTestId, getByText } = render(
      <PhoneInput
        countryCode="+91"
        value="123"
        onChangeText={jest.fn()}
        error="Please enter a valid 10-digit mobile number."
      />
    );

    const errorEl = getByTestId('phone-input-error');
    expect(errorEl.props.accessibilityRole).toBe('alert');
    expect(getByText('Please enter a valid 10-digit mobile number.')).toBeTruthy();

    const input = getByTestId('phone-input');
    expect(input.props['aria-invalid']).toBe(true);
  });

  it('disables input when loading or disabled', () => {
    const { getByTestId } = render(
      <PhoneInput
        countryCode="+91"
        value=""
        onChangeText={jest.fn()}
        disabled={true}
        loading={true}
      />
    );

    const input = getByTestId('phone-input');
    expect(input.props.editable).toBe(false);
  });

  it('allows opening country picker modal and selecting another country', () => {
    const onCountryCodeChange = jest.fn();
    const { getByTestId, getByText } = render(
      <PhoneInput
        countryCode="+91"
        onCountryCodeChange={onCountryCodeChange}
        value=""
        onChangeText={jest.fn()}
      />
    );

    const pickerBtn = getByTestId('phone-input-country-picker');
    fireEvent.press(pickerBtn);

    expect(getByText('Select Country')).toBeTruthy();
    const usOption = getByTestId('country-option-us');
    fireEvent.press(usOption);

    expect(onCountryCodeChange).toHaveBeenCalledWith('+1');
  });
});
