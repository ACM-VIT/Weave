import React, { createContext, useCallback, useContext, useState } from 'react';
import { OnboardingData } from '../api/onboarding';
import { ONBOARDING_INTERESTS } from '../../backend/contracts/onboardingTaxonomy';

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
    setData((prev) => {
      const patch = typeof updates === 'function' ? updates(prev) : updates;
      const next = { ...prev, ...patch };
      if (Object.hasOwn(patch, 'skills') && next.interests) {
        const visibleInterests = new Set<string>(ONBOARDING_INTERESTS
          .filter(category => next.skills?.includes(category.id))
          .flatMap(category => category.interests.map(interest => interest.id)));
        // Step 1 can change while Step 3 is unmounted. Do not count or submit
        // selections that the replacement categories no longer let users see.
        next.interests = next.interests.filter(interest => visibleInterests.has(interest));
      }
      return next;
    });
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
