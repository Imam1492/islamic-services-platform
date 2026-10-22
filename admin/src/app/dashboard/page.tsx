import { requireSuperAdmin } from '@/lib/auth/super-admin';

export default async function DashboardPage() {
  await requireSuperAdmin();

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
      <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
      <p className="text-zinc-600 mt-2">Protected area for administrative sessions.</p>
    </div>
  );
}
