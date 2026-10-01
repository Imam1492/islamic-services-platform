export interface CountryCodeOption {
  code: string;
  iso: string;
  label: string;
  flag: string;
  digits: number;
}

export const SUPPORTED_COUNTRIES: CountryCodeOption[] = [
  { code: '+91', iso: 'IN', label: 'India (+91)', flag: '🇮🇳', digits: 10 },
  { code: '+1', iso: 'US', label: 'United States (+1)', flag: '🇺🇸', digits: 10 },
  { code: '+44', iso: 'GB', label: 'United Kingdom (+44)', flag: '🇬🇧', digits: 10 },
  { code: '+971', iso: 'AE', label: 'United Arab Emirates (+971)', flag: '🇦🇪', digits: 9 },
  { code: '+65', iso: 'SG', label: 'Singapore (+65)', flag: '🇸🇬', digits: 8 },
];

export const DEFAULT_COUNTRY_CODE = '+91';

/**
 * Strips all non-digit characters from a phone number string.
 */
export function cleanDigits(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Canonicalizes a country code and national number into standard E.164 format.
 * E.164 format: +[country-code][subscriber-number] with no spaces, hyphens, or symbols.
 */
export function toE164(countryCode: string, nationalNumber: string): string {
  const cleanCode = countryCode.startsWith('+')
    ? countryCode
    : `+${countryCode.replace(/\D/g, '')}`;

  let digits = cleanDigits(nationalNumber);

  // If user included country code digits in national input by accident, trim it
  const codeDigits = cleanDigits(cleanCode);
  if (digits.startsWith(codeDigits) && digits.length > codeDigits.length) {
    digits = digits.slice(codeDigits.length);
  }

  // Handle leading 0 commonly used in Indian trunk dialing (e.g., 09876543210 -> 9876543210)
  if (cleanCode === '+91' && digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return `${cleanCode}${digits}`;
}

export interface PhoneValidationResult {
  isValid: boolean;
  e164: string;
  error?: string;
}

/**
 * Validates phone input and returns the canonical E.164 string or an error.
 * Client-side validation is UX-only to provide immediate feedback;
 * Supabase Auth remains the authoritative boundary.
 */
export function validatePhoneInput(
  countryCode: string,
  nationalNumber: string
): PhoneValidationResult {
  const digits = cleanDigits(nationalNumber);

  if (!digits) {
    return {
      isValid: false,
      e164: '',
      error: 'Please enter your mobile phone number.',
    };
  }

  const canonical = toE164(countryCode, nationalNumber);

  // India (+91) specific mobile validation: exactly 10 digits starting with 6, 7, 8, or 9
  if (countryCode === '+91') {
    const subscriber = cleanDigits(canonical.replace(/^\+91/, ''));
    if (subscriber.length !== 10) {
      return {
        isValid: false,
        e164: canonical,
        error: 'Please enter a valid 10-digit mobile number.',
      };
    }
    if (!/^[6-9]\d{9}$/.test(subscriber)) {
      return {
        isValid: false,
        e164: canonical,
        error: 'Indian mobile numbers must start with 6, 7, 8, or 9.',
      };
    }
    return {
      isValid: true,
      e164: canonical,
    };
  }

  // Generic international E.164 format: + followed by 7 to 15 digits
  const e164Regex = /^\+[1-9]\d{6,14}$/;
  if (!e164Regex.test(canonical)) {
    return {
      isValid: false,
      e164: canonical,
      error: 'Please enter a valid phone number.',
    };
  }

  return {
    isValid: true,
    e164: canonical,
  };
}

/**
 * Converts Supabase/system errors into safe user-facing error messages.
 * Never leaks stack traces, internal URLs, database error messages, or Supabase error codes.
 */
export function getSafeAuthErrorMessage(
  error: unknown,
  context: 'phone_entry' | 'otp_verify' | 'otp_resend'
): string {
  if (!error) return '';

  const errObj = error as { message?: string; status?: number };
  const message = typeof errObj?.message === 'string' ? errObj.message.toLowerCase() : '';
  const status = typeof errObj?.status === 'number' ? errObj.status : 0;

  // Rate limiting / Too many requests
  if (
    status === 429 ||
    message.includes('rate limit') ||
    message.includes('too many') ||
    message.includes('security purposes')
  ) {
    if (context === 'otp_resend') {
      return 'Too many requests. Please wait a moment before requesting another code.';
    }
    return 'Too many requests. Please wait a moment before trying again.';
  }

  // Network / Connection errors
  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('connection') ||
    message.includes('failed to fetch') ||
    message.includes('timeout')
  ) {
    return 'Network connection error. Please check your internet connection and try again.';
  }

  // Context-specific messages
  if (context === 'phone_entry') {
    if (message.includes('invalid') || message.includes('phone') || message.includes('format')) {
      return 'Please enter a valid phone number.';
    }
    return 'Unable to send verification code. Please try again.';
  }

  if (context === 'otp_verify') {
    if (message.includes('expired')) {
      return 'The verification code has expired. Please request a new one.';
    }
    if (
      message.includes('invalid') ||
      message.includes('token') ||
      message.includes('otp') ||
      message.includes('incorrect')
    ) {
      return 'Invalid verification code. Please check the code and try again.';
    }
    return 'Verification failed. Please check the code and try again.';
  }

  if (context === 'otp_resend') {
    return 'Unable to resend code. Please try again in a few moments.';
  }

  return 'An unexpected error occurred. Please try again.';
}

/**
 * Masks a phone number string for privacy-compliant UI display.
 * Retains the country code prefix (if present) and the last 4 digits,
 * replacing the remaining subscriber digits with masked bullets.
 * Example: "+919876543210" -> "+91 ••••• •3210"
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const clean = phone.trim();
  if (clean.length <= 4) return '••••';

  if (clean.startsWith('+')) {
    const match = clean.match(/^(\+\d{1,3})(\d+)$/);
    if (match) {
      const countryCode = match[1];
      const subscriber = match[2];
      if (subscriber.length <= 4) {
        return `${countryCode} ••••`;
      }
      const lastFour = subscriber.slice(-4);
      const maskedLength = subscriber.length - 4;
      const bullets = '•'.repeat(Math.min(maskedLength, 5));
      return `${countryCode} ${bullets} ${lastFour}`;
    }
  }

  const lastFour = clean.slice(-4);
  return `•••• ••${lastFour}`;
}
