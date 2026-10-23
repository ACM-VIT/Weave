import React, { createContext, useContext, useState } from 'react';
import { OnboardingData } from '../api/onboarding';

interface OnboardingContextType {
  data: Partial<OnboardingData>;
  githubControlRevision: number;
  updateData: (updates: Partial<OnboardingData>) => void;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function OnboardingProvider({ children, githubControlRevision = 0 }: { children: React.ReactNode; githubControlRevision?: number }) {
  const [data, setData] = useState<Partial<OnboardingData>>({});

  const updateData = (updates: Partial<OnboardingData>) => {
    setData((prev) => ({ ...prev, ...updates }));
  };

  return (
    <OnboardingContext.Provider value={{ data, updateData, githubControlRevision }}>
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
