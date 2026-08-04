import type { Metadata } from 'next';
import { AppSidebar } from '@/components/app-sidebar';
import { AppTopbar } from '@/components/app-topbar';
import { AuthGate } from '@/components/auth-gate';
import { TooltipProvider } from '@/components/ui/tooltip';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <TooltipProvider delayDuration={200}>
        {/* Fixed viewport shell: sidebar never scrolls with content, only the
            right-side <main> area scrolls. On small screens (< lg) the sidebar
            is hidden and the whole page falls back to normal document flow. */}
        <div className="lg:h-screen lg:overflow-hidden flex">
          <AppSidebar />
          <div className="flex-1 flex flex-col min-w-0 lg:h-screen">
            <AppTopbar />
            <main className="flex-1 min-w-0 min-h-0 p-6 overflow-y-auto scrollbar-thin">{children}</main>
          </div>
        </div>
      </TooltipProvider>
    </AuthGate>
  );
}
