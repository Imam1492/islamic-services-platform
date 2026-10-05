import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { PhoneInput } from '../src/components/PhoneInput';
import {
  validatePhoneInput,
  toE164,
  cleanDigits,
  getSafeAuthErrorMessage,
} from '../src/utils/phone';

describe('Phone Utility & Input Validation', () => {
  it('cleans non-digit characters correctly', () => {
    expect(cleanDigits('98765-43210')).toBe('9876543210');
    expect(cleanDigits('(987) 654 3210')).toBe('9876543210');
    expect(cleanDigits('+91 98765 43210')).toBe('919876543210');
  });

  it('canonicalizes Indian numbers to E.164', () => {
    // Standard 10-digit number
    expect(toE164('+91', '9876543210')).toBe('+919876543210');
    // Valid Indian 10-digit number starting with 96 (user reported number)
    expect(toE164('+91', '9676290430')).toBe('+919676290430');
    // Valid Indian 10-digit number starting with 91 - MUST NOT truncate national number
    expect(toE164('+91', '9123456789')).toBe('+919123456789');
    // Trims leading 0 in Indian trunk dialing (11 digits: 0 + 10 digits)
    expect(toE164('+91', '09676290430')).toBe('+919676290430');
    expect(toE164('+91', '09876543210')).toBe('+919876543210');
    // Trims duplicated country code when 12 digits (91 + 10 digits)
    expect(toE164('+91', '919676290430')).toBe('+919676290430');
    expect(toE164('91', '9676290430')).toBe('+919676290430');
  });

  it('validates valid Indian numbers starting with 6, 7, 8, 9', () => {
    const validNumbers = [
      '9676290430', // Exact user-reported number
      '9876543210', // Series 9
      '9123456789', // Series 9 (starting with 91)
      '8123456789', // Series 8
      '8987654321', // Series 8
      '7001122334', // Series 7
      '7987654321', // Series 7
      '6987654321', // Series 6
      '6234567890', // Series 6
    ];
    for (const num of validNumbers) {
      const result = validatePhoneInput('+91', num);
      expect(result.isValid).toBe(true);
      expect(result.e164).toBe(`+91${num}`);
      expect(result.error).toBeUndefined();
    }
  });

  it('accepts country code with or without plus sign', () => {
    const withPlus = validatePhoneInput('+91', '9676290430');
    expect(withPlus.isValid).toBe(true);
    expect(withPlus.e164).toBe('+919676290430');

    const withoutPlus = validatePhoneInput('91', '9676290430');
    expect(withoutPlus.isValid).toBe(true);
    expect(withoutPlus.e164).toBe('+919676290430');
  });

  it('rejects malformed Indian numbers with invalid starting digits (0-5)', () => {
    const invalidStartingDigits = [
      '0123456789',
      '1234567890',
      '2345678901',
      '3456789012',
      '4567890123',
      '5123456789',
    ];
    for (const num of invalidStartingDigits) {
      const result = validatePhoneInput('+91', num);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Indian mobile numbers must start with 6, 7, 8, or 9.');
    }
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

  describe('Auth Error Mapping (getSafeAuthErrorMessage)', () => {
    it('maps provider disabled/unsupported errors to safe service error, not invalid phone error', () => {
      expect(
        getSafeAuthErrorMessage({ message: 'Unsupported phone provider' }, 'phone_entry')
      ).toBe('Unable to send verification code. Please try again.');

      expect(
        getSafeAuthErrorMessage({ message: 'Phone provider is not enabled' }, 'phone_entry')
      ).toBe('Unable to send verification code. Please try again.');

      expect(
        getSafeAuthErrorMessage({ message: 'SMS provider not configured' }, 'phone_entry')
      ).toBe('Unable to send verification code. Please try again.');
    });

    it('maps genuine phone number format errors to valid phone prompt', () => {
      expect(
        getSafeAuthErrorMessage({ message: 'Invalid phone number' }, 'phone_entry')
      ).toBe('Please enter a valid phone number.');

      expect(
        getSafeAuthErrorMessage({ message: 'Invalid phone number format' }, 'phone_entry')
      ).toBe('Please enter a valid phone number.');
    });
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
