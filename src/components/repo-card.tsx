import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Ellipse, Path, Rect, Text as SvgText } from 'react-native-svg';

interface RepoCardProps {
  label: string;
  height: number;
  variant?: 'center' | 'section';
  isSmallPhone?: boolean;
}

// High-fidelity Inline SVGs for brand logos
function ReactLogo() {
  return (
    <Svg viewBox="-11.5 -10.23 23 20.46" width={11} height={11}>
      <Circle cx="0" cy="0" r="2.05" fill="#61DAFB" />
      <Ellipse rx="11" ry="4.2" fill="none" stroke="#61DAFB" strokeWidth="1" transform="rotate(0)" />
      <Ellipse rx="11" ry="4.2" fill="none" stroke="#61DAFB" strokeWidth="1" transform="rotate(60)" />
      <Ellipse rx="11" ry="4.2" fill="none" stroke="#61DAFB" strokeWidth="1" transform="rotate(120)" />
    </Svg>
  );
}

function NodeLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Path fill="#339933" d="M12 2L3.5 7v10L12 22l8.5-5V7L12 2zm-1 16.5l-4.5-2.6v-5.2l4.5 2.6v5.2zm1-7.3L7.5 8.6 12 6l4.5 2.6L12 11.2zm5.5 4.7l-4.5 2.6v-5.2l4.5-2.6v5.2z" />
    </Svg>
  );
}

function PythonLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Path fill="#3776AB" d="M11.93 2c-2.67 0-4.96.2-4.96 2.5v1.88h5V7.5H7.07c-1.84 0-3.3 1.34-3.3 3.12v2.3h2.08v-1.88c0-1.25.92-2.3 2.08-2.3h5V7.07c0-2.3-2.3-3.07-5-3.07z" />
      <Path fill="#FFE873" d="M12.07 22c2.67 0 4.96-.2 4.96-2.5v-1.88h-5v-1.12h4.9c1.84 0 3.3-1.34 3.3-3.12v-2.3H18.15v1.88c0 1.25-.92 2.3-2.08 2.3h-5v1.67c0 2.3 2.3 3.07 5 3.07z" />
    </Svg>
  );
}

function TSLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Rect width="24" height="24" rx="4" fill="#3178C6" />
      <SvgText x="12" y="17" fill="#FFFFFF" fontSize="13" fontWeight="bold" textAnchor="middle" fontFamily="System">TS</SvgText>
    </Svg>
  );
}

function MongoDBLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Path fill="#47A248" d="M12 2c0 0-5.5 4.5-5.5 10.5S10 20.5 12 22c2-1.5 5.5-3.5 5.5-9.5S12 2 12 2zm0 17c-1.5-1-4-3-4-6.5S10.5 6 12 4.5c1.5 1.5 4 4.5 4 8s-2.5 5.5-4 6.5z" />
    </Svg>
  );
}

function DockerLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Path fill="#2496ED" d="M13.96 6.08h-2.43V8.5h2.43V6.08zM11.03 6.08H8.59V8.5h2.44V6.08zM11.03 3.13H8.59v2.43h2.44V3.13zM8.09 6.08H5.66V8.5H8.09V6.08zM5.19 6.08H2.76V8.5H5.19V6.08zM5.19 3.13H2.76v2.43H5.19V3.13zM13.96 3.13h-2.43v2.43h2.43V3.13zm2.9 2.95h-2.43V8.5h2.43V6.08zM22.84 8.22c-.11-.76-.71-1.28-1.58-1.28H19.78V4.5c0-.85-.68-1.5-1.5-1.5H3.06c-.82 0-1.5.65-1.5 1.5v9.1c0 2.89 2.5 5.23 5.57 5.23h10.45c3.08 0 5.58-2.34 5.58-5.23V8.22z" />
    </Svg>
  );
}

function NextLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Circle cx="12" cy="12" r="12" fill="#000000" />
      <Path fill="#FFFFFF" d="M18.5 17.5L12 9v8.5H10V7h2l6.5 8.5V7h2v10.5z" />
    </Svg>
  );
}

function TailwindLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Path fill="#06B6D4" d="M12 6c0 0-3 3-6 3-3.6 0-4.8 3-4.8 3s3-3 6-3c3.6 0 4.8 3 4.8 3s-3 3-6 3c-3.6 0-4.8 3-4.8 3s3-3 6-3c3.6 0 4.8 3 4.8 3s3.6-3 7.2-3c3 0 6 3 6 3s-3-3-6-3c-3.6 0-4.8-3-4.8-3s3-3 6-3c3.6 0 4.8 3 4.8 3s-3-3-6-3c-3.6 0-4.8-3-4.8-3z" />
    </Svg>
  );
}

function GitLogo() {
  return (
    <Svg viewBox="0 0 24 24" width={11} height={11}>
      <Path fill="#F05032" d="M20.8 10.9L13.1 3.2c-.4-.4-1.1-.4-1.5 0L9.4 5.4l2.4 2.4c.5-.2 1.1-.1 1.5.3.4.4.5 1 .3 1.5l2.4 2.4c.5-.2 1.1-.1 1.5.3.5.5.5 1.3 0 1.9s-1.4.5-1.9 0c-.4-.4-.5-1-.3-1.5l-2.4-2.4c-.5.2-1.1.1-1.5-.3-.4-.4-.5-1-.3-1.5L9 6.2l-5.8 5.8c-.4.4-.4 1.1 0 1.5l7.7 7.7c.4.4 1.1.4 1.5 0l8.4-8.4c.4-.4.4-1.2 0-1.6z" />
    </Svg>
  );
}

const TECH_STACK_ITEMS = [
  { name: 'React', SvgComponent: ReactLogo },
  { name: 'Node.js', SvgComponent: NodeLogo },
  { name: 'Python', SvgComponent: PythonLogo },
  { name: 'TypeScript', SvgComponent: TSLogo },
  { name: 'MongoDB', SvgComponent: MongoDBLogo },
  { name: 'Docker', SvgComponent: DockerLogo },
  { name: 'Next.js', SvgComponent: NextLogo },
  { name: 'Tailwind', SvgComponent: TailwindLogo },
  { name: 'Git', SvgComponent: GitLogo },
];

export function RepoCard({ label, height, variant = 'center', isSmallPhone }: RepoCardProps) {
  const isTechStack = label.toLowerCase() === 'tech stack';

  return (
    <Pressable
      style={({ pressed }) => [
        { height, width: '100%' },
        pressed && styles.cardPressed,
      ]}
    >
      <View style={[styles.card, { height, width: '100%' }]}>
        {isTechStack ? (
          <View style={styles.techStackContainer}>
            <Text style={[styles.techStackTitle, isSmallPhone && { fontSize: 10, paddingTop: 10 }]}>TECH STACK</Text>
            <View style={styles.techStackGrid}>
              {TECH_STACK_ITEMS.map((item) => (
                <View key={item.name} style={[styles.techStackTile, isSmallPhone && { height: 24 }]}>
                  <item.SvgComponent />
                  <Text style={[styles.techStackText, isSmallPhone && { fontSize: 6.5 }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : variant === 'section' ? (
          <Text style={[styles.sectionLabel, isSmallPhone && { fontSize: 9.5, paddingTop: 12 }]}>{label}</Text>
        ) : (
          <View style={styles.centerLabelWrap}>
            <Text style={[styles.centerLabel, isSmallPhone && { fontSize: 12 }]}>{label}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#6DA963',
    backgroundColor: '#273126',
    overflow: 'hidden',
  },
  cardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.995 }],
  },
  centerLabelWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerLabel: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Regular',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  sectionLabel: {
    color: '#6DA963',
    fontFamily: 'NataSans-Medium',
    fontSize: 11,
    letterSpacing: 0,
    lineHeight: 15,
    paddingLeft: 14,
    paddingTop: 15,
    textTransform: 'uppercase',
  },
  techStackContainer: {
    flex: 1,
  },
  techStackTitle: {
    color: '#6DA963',
    fontFamily: 'NataSans-Medium',
    fontSize: 11,
    letterSpacing: 0,
    lineHeight: 15,
    paddingLeft: 14,
    paddingTop: 12,
    textTransform: 'uppercase',
  },
  techStackGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
  },
  techStackTile: {
    width: '31%',
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#4A6B44',
    backgroundColor: '#1E241E',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  techStackText: {
    color: '#FFFFFF',
    fontFamily: 'NataSans-Regular',
    fontSize: 7.5,
    fontWeight: '500',
  },
});
