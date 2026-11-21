import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider, useLanguage } from './context/LanguageContext';
import { PortalLanding } from './components/PortalLanding';
import { WorkspaceShell } from './components/WorkspaceShell';

function AppContent() {
  const { user, profile, loading } = useAuth();
  const { t } = useLanguage();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center gap-3 text-slate-600">
        <Loader2 className="w-6 h-6 animate-spin text-blue-700" aria-hidden="true" />
        <p className="text-sm font-medium">{t('app.verifyingSession')}</p>
      </div>
    );
  }

  if (!user || !profile) {
    return <PortalLanding />;
  }

  return <WorkspaceShell key={profile.uid} />;
}

export default function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </LanguageProvider>
  );
}
