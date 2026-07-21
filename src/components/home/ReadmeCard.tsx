import React, { useMemo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { BookOpen, ChevronRight } from 'lucide-react-native';
import RenderHtml, { defaultSystemFonts } from 'react-native-render-html';
import { marked } from 'marked';

import { REFERENCE_THEME } from '@/constants/theme';

type RepositoryData = {
  title: string;
  readmeSummary: string;
  readmeFull: string;
  techStack?: string[];
};

type ReadmeCardProps = {
  repository: RepositoryData;
  availableWidth: number;
  onReadFullPress: () => void;
  compact?: boolean;
};

const LANGUAGE_COLOURS: Record<string, string> = {
  Rust: '#DEA584',
  Go: '#00ADD8',
  Python: '#3572A5',
  TypeScript: '#3178C6',
  JavaScript: '#F7DF1E',
  Javascript: '#F7DF1E',
  React: '#61DAFB',
};

const README_PREVIEW_MAX_CHARACTERS = 4_000;
const markdownFonts = [
  ...defaultSystemFonts,
  'NataSans-Regular',
  'NataSans-SemiBold',
  'NataSans-Bold',
];

const markdownTagStyles = {
  body: {
    color: REFERENCE_THEME.textStrong,
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
    lineHeight: 22,
  },
  p: {
    marginTop: 0,
    marginBottom: 8,
  },
  h1: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 18,
    lineHeight: 24,
    marginTop: 0,
    marginBottom: 8,
  },
  h2: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
    fontSize: 16,
    lineHeight: 22,
    marginTop: 0,
    marginBottom: 7,
  },
  h3: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 15,
    lineHeight: 21,
    marginTop: 0,
    marginBottom: 6,
  },
  a: {
    color: REFERENCE_THEME.accentLight,
    textDecorationLine: 'underline' as const,
  },
  strong: {
    color: REFERENCE_THEME.text,
    fontFamily: 'NataSans-Bold',
  },
  ul: {
    marginTop: 0,
    marginBottom: 8,
    paddingLeft: 6,
  },
  ol: {
    marginTop: 0,
    marginBottom: 8,
    paddingLeft: 6,
  },
  li: {
    marginBottom: 3,
  },
  code: {
    borderRadius: 4,
    paddingHorizontal: 4,
    backgroundColor: 'rgba(255,255,255,0.09)',
    color: REFERENCE_THEME.text,
    fontFamily: 'monospace',
    fontSize: 12,
  },
} as const;

export default function ReadmeCard({
  repository,
  availableWidth,
  onReadFullPress,
  compact = false,
}: ReadmeCardProps) {
  const summary = repository.readmeSummary || repository.readmeFull || 'No summary available.';
  const preview = summary.slice(0, README_PREVIEW_MAX_CHARACTERS);
  const markdownHtml = useMemo(
    () => marked.parse(preview, { async: false, gfm: true }) as string,
    [preview],
  );
  const language = repository.techStack?.[0] || 'Code';
  const languageColour = LANGUAGE_COLOURS[language] ?? '#8E8E93';

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={[styles.header, compact && styles.headerCompact]}>
        <View style={styles.headerLabel}>
          <BookOpen size={12} color={REFERENCE_THEME.accentLight} strokeWidth={2} />
          <Text style={styles.heading}>README</Text>
        </View>
        <View style={styles.language}>
          <View style={[styles.languageDot, { backgroundColor: languageColour }]} />
          <Text style={styles.languageText} numberOfLines={1}>{language}</Text>
        </View>
      </View>

      <View style={[styles.body, compact && styles.bodyCompact]}>
        <View style={[styles.markdownViewport, compact && styles.markdownViewportCompact]}>
          <RenderHtml
            contentWidth={Math.max(availableWidth - (compact ? 28 : 36), 1)}
            defaultTextProps={{ selectable: true }}
            enableExperimentalMarginCollapsing
            ignoredDomTags={['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'img']}
            renderersProps={{
              a: {
                onPress: (_event, href) => {
                  if (/^(https?:|mailto:)/i.test(href)) void Linking.openURL(href);
                },
              },
            }}
            source={{ html: markdownHtml }}
            systemFonts={markdownFonts}
            tagsStyles={markdownTagStyles}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={onReadFullPress}
          style={({ pressed }) => [styles.readFull, pressed && styles.pressed]}
        >
          <Text style={styles.readFullText}>Read full</Text>
          <ChevronRight size={11} color={REFERENCE_THEME.accentLight} strokeWidth={2.4} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 10,
    borderRadius: 18,
    backgroundColor: 'rgba(28,28,30,0.78)',
    overflow: 'hidden',
  },
  cardCompact: {
    marginTop: 6,
  },
  header: {
    minHeight: 41,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  headerCompact: {
    minHeight: 35,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  headerLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heading: {
    color: REFERENCE_THEME.accentLight,
    fontFamily: 'NataSans-Bold',
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.6,
  },
  language: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  languageDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  languageText: {
    maxWidth: 110,
    color: REFERENCE_THEME.textSecondary,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 10.5,
    lineHeight: 14,
  },
  body: {
    paddingTop: 15,
    paddingHorizontal: 18,
    paddingBottom: 22,
    gap: 12,
  },
  bodyCompact: {
    paddingTop: 9,
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 6,
  },
  markdownViewport: {
    minHeight: 150,
    maxHeight: 150,
    overflow: 'hidden',
  },
  markdownViewportCompact: {
    minHeight: 54,
    maxHeight: 88,
  },
  readFull: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  readFullText: {
    color: REFERENCE_THEME.accentLight,
    fontFamily: 'NataSans-SemiBold',
    fontSize: 12,
    lineHeight: 16,
  },
  pressed: {
    opacity: 0.7,
  },
});
