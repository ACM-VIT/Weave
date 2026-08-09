import { Alert, Linking } from 'react-native';

function isSupportedExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

export function isGithubReadmeLink(href: string): boolean {
  try {
    const url = new URL(href);
    const hostname = url.hostname.toLocaleLowerCase();
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && (hostname === 'github.com' || hostname.endsWith('.github.com'));
  } catch {
    return false;
  }
}

/**
 * README links may leave Weave, but GitHub links require an explicit external
 * navigation confirmation so they cannot masquerade as an internal repo card.
 */
export function openReadmeExternalLink(href: string): void {
  if (!isSupportedExternalLink(href)) return;

  const openLink = () => {
    void Linking.openURL(href).catch(() => undefined);
  };

  if (!isGithubReadmeLink(href)) {
    openLink();
    return;
  }

  Alert.alert(
    'Open on GitHub?',
    'This README link will leave Weave and open GitHub.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Open on GitHub', onPress: openLink },
    ],
  );
}
