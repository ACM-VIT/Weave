import React, { createContext, useCallback, useContext, useState } from 'react';
import { OnboardingData } from '../api/onboarding';

interface OnboardingContextType {
  data: Partial<OnboardingData>;
  githubImportRevision: number;
  invalidateGitHubImport: () => void;
  updateData: (updates: Partial<OnboardingData> | ((previous: Partial<OnboardingData>) => Partial<OnboardingData>)) => void;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [githubImportRevision, setGitHubImportRevision] = useState(0);
  const invalidateGitHubImport = useCallback(() => setGitHubImportRevision(value => value + 1), []);
  const [data, setData] = useState<Partial<OnboardingData>>({});

  const updateData = useCallback<OnboardingContextType['updateData']>((updates) => {
    setData((prev) => ({ ...prev, ...(typeof updates === 'function' ? updates(prev) : updates) }));
  }, []);

  return (
    <OnboardingContext.Provider value={{ data, updateData, githubImportRevision, invalidateGitHubImport }}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error('useOnboarding must be used within OnboardingProvider');
  }
  return context;
}
