// Render the production components with only native/network boundaries replaced.
// These tests exercise callback ordering and UI state, not device/browser gestures.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as githubOpen from '../../src/services/repositoryGithubOpen';
import * as repositoryLinks from '../../src/utils/repository-links';
import * as shareFeedback from '../../src/utils/share-feedback';
const REFERENCE_THEME = { text: '#ffffff', textSecondary: '#aaaaaa', accent: '#63E08A' };

export const repository = {
  id: 'repo', name: 'repo', fullName: 'owner/repo', owner: 'owner',
  githubUrl: 'https://github.com/owner/repo', description: 'Repository description',
  stats: { stars: 1, forks: 0, views: 0, likes: 0, openIssues: 0 },
  languages: [], topics: [], selectedListIds: [], viewerSaved: false,
};

export function loadActionComponent(path: string, overrides: Record<string, any> = {}) {
  const animation = () => ({ start: (callback?: (state: { finished: boolean }) => void) => callback?.({ finished: true }) });
  class Value { setValue() {} }
  const native = {
    ActivityIndicator: 'ActivityIndicator', Animated: { Value, View: 'AnimatedView', timing: animation, parallel: animation },
    Alert: { alert() {} }, Easing: { bezier: () => 0, in: () => 0, cubic: 0 },
    Linking: { openURL: async () => {} }, Platform: { OS: 'ios' },
    Modal: 'Modal', Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    Share: { share: async () => ({ action: 'dismissedAction' }), sharedAction: 'sharedAction' },
    StyleSheet: { absoluteFill: {}, create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 320, height: 568, fontScale: 1.6 }),
    ...overrides.native,
  };
  const mocks: Record<string, any> = {
    'react-native': native,
    'react-native-reanimated': { useReducedMotion: () => true },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    'expo-blur': { BlurView: 'BlurView' },
    'expo-clipboard': { setStringAsync: async () => true },
    'expo-linking': { createURL: () => 'ghsocial://repository/repo' },
    'expo-haptics': { selectionAsync: async () => {}, notificationAsync: async () => {}, NotificationFeedbackType: { Success: 'success' } },
    'expo-router': { router: { canGoBack: () => true, back() {}, replace() {} } },
    '@tanstack/react-query': { useQuery: () => ({ data: repository }), useQueryClient: () => ({}) },
    'lucide-react-native': new Proxy({}, { get: (_, key) => typeof key === 'string' ? key : undefined }),
    '@/api/repositories': { repositoryDetailQueryKey: () => ['repository'], fetchRepositoryDetail: async () => repository },
    '@/constants/theme': { REFERENCE_THEME },
    '@/hooks/use-modal-scroll-lock': { useModalScrollLock() {} },
    '@/hooks/use-repository-readme-summary': { useRepositoryReadmeSummary: () => ({ digest: null }) },
    '@/store/AuthContext': { useAuth: () => ({ user: { user_id: 'viewer' } }) },
    '@/utils/storage': { getStorageItem: async () => 'token' },
    '@/utils/repository-links': repositoryLinks,
    '@/utils/share-feedback': shareFeedback,
    '@/services/repositoryGithubOpen': githubOpen,
    '../../services/repositoryGithubOpen': githubOpen,
    '@/utils/avatar-color': { getAvatarColor: () => '#123456' },
    '@/utils/follow-state': { getProfileFollowIdentity: () => ({}) },
    './DescriptionCard': { __esModule: true, default: () => null }, './ReadmeCard': { __esModule: true, default: () => null },
    './RecommendationReason': { RecommendationReason: () => null }, '../follow-button': { FollowButton: () => null },
    '@/api/session-lifecycle': { authSessionLifecycle: { currentGeneration: () => 1, isCurrent: () => true } },
    '@/services/feedImpressionAttribution': { takeFeedNavigation: () => null },
    '@/services/activityOutboxClient': { queueActivityForViewer: async () => {} },
    '@/utils/format-count': { formatCompactCount: String },
    '@/utils/readme': { prepareReadmePreview: () => ({ markdown: '', source: 'unavailable' }), prepareReadmeSummaryDocument: () => '' },
    '@/components/home/ReadmePopup': { ReadmePopup: () => null }, '@/components/home/save-popup': { SavePopup: () => null },
    '@/components/home/share-repository-sheet': { ShareRepositorySheet: () => null },
    ...overrides,
  };
  const filename = resolve(path);
  const nativeRequire = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (specifier: string) => mocks[specifier] ?? nativeRequire(specifier), loaded, loaded.exports,
  );
  return loaded.exports;
}
