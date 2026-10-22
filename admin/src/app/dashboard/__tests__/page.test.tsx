import { requireSuperAdmin } from '../../../lib/auth/super-admin';
import DashboardPage from '../page';

jest.mock('../../../lib/auth/super-admin', () => ({ requireSuperAdmin: jest.fn() }));

describe('Dashboard page authorization boundary', () => {
  it('checks authorization when called directly, independently of Proxy', async () => {
    await DashboardPage();
    expect(requireSuperAdmin).toHaveBeenCalledTimes(1);
  });
});
