const LOCAL_EMULATOR_API = 'http://10.0.2.2:3000';
const PROD_API = 'https://app.assist4web.com';

// For production builds this automatically points to your hosted subdomain.
export const API_BASE_URL = __DEV__ ? LOCAL_EMULATOR_API : PROD_API;

// Optional: set when server-side MOBILE_API_KEY is enabled.
export const MOBILE_API_KEY = '';

export const withApiHeaders = (
  headers: Record<string, string> = {},
): Record<string, string> => {
  const merged = { ...headers };

  if (MOBILE_API_KEY) {
    merged['x-api-key'] = MOBILE_API_KEY;
  }

  return merged;
};

export const withJsonApiHeaders = (
  headers: Record<string, string> = {},
): Record<string, string> =>
  withApiHeaders({
    'Content-Type': 'application/json',
    ...headers,
  });

export const socketAuthOptions = () =>
  MOBILE_API_KEY
    ? {
        auth: { apiKey: MOBILE_API_KEY },
      }
    : {};
