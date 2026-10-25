import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import { buildOnboardingPayload, normalizeOnboardingSlug } from "../src/utils/onboarding-payload";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { resolveOnboardingTaxonomy, type OnboardingTaxonomy } from "../src/utils/onboardingTaxonomy";
import { loadSource } from "./support/startup-harness";

describe("onboarding payload", () => {
  test('onboarding sends legacy topics and structured persona fields with valid slugs', () => {
    const payload = buildOnboardingPayload({
      bio: 'dev',
      interests: ['github actions', 'ci/cd', 'c++', 'github actions'],
      skills: ['web', 'devops'],
      tech_stack: ['Node.js'],
    });

    assert.deepEqual(payload.interests, ['github-actions', 'ci-cd', 'cpp']);
    assert.deepEqual(payload.skills, ['web-frontend-frameworks', 'devops-infrastructure-and-security']);
    assert.deepEqual(payload.tech_stack, ['node-js']);
    assert.deepEqual(payload.topics, [
      'github-actions', 'ci-cd', 'cpp', 'web-frontend-frameworks', 'devops-infrastructure-and-security', 'node-js',
    ]);
    assert.equal(payload.bio, 'dev');
    assert.deepEqual(payload.taxonomy_selections.skills.map(entry => entry.id), ['web', 'devops']);
    assert.equal(payload.taxonomy_selections.skills[0].label, 'Web / Frontend Frameworks');
  });

  test('onboarding normalization always produces the backend slug format', () => {
    assert.equal(normalizeOnboardingSlug('Machine Learning'), 'machine-learning');
    assert.equal(normalizeOnboardingSlug('  CI/CD  '), 'ci-cd');
    assert.match(normalizeOnboardingSlug('ASP.NET'), /^[a-z0-9][a-z0-9-]{0,49}$/);
  });

  test('onboarding rejects an oversized bio before making the completion request', () => {
    assert.throws(
      () => buildOnboardingPayload({ bio: 'x'.repeat(2001), interests: ['react'] }),
      /2000 characters/,
    );
  });

  test('combined structured selections accept 100 unique topics but reject 101 without truncation', async () => {
    const { ONBOARDING_SKILLS, ONBOARDING_INTERESTS } = await import('../backend/contracts/onboardingTaxonomy');
    const skills = ONBOARDING_SKILLS.map(entry => entry.id);
    const interests = [...new Set(ONBOARDING_INTERESTS.flatMap(category => category.interests.map(entry => entry.id)))];
    const selections = { skills, interests: interests.slice(0, 43), tech_stack: Array.from({ length: 50 }, (_, n) => `fixture-tech-${n}`) };
    const payload = buildOnboardingPayload(selections);
    assert.equal(new Set([...payload.skills, ...payload.interests, ...payload.tech_stack]).size, 100);
    assert.throws(() => buildOnboardingPayload({ ...selections, interests: interests.slice(0, 44) }), /100 unique/);
  });
});

describe("onboarding taxonomy", () => {
  // Use the actual displayed taxonomy. Only image imports are replaced: SVG
  // rendering is unrelated to the ID/label boundary and cannot run in Node.
  async function displayedTaxonomy(): Promise<OnboardingTaxonomy> {
    const result = await build({
      entryPoints: [path.resolve('src/constants/onboarding.tsx')], bundle: true,
      platform: 'node', format: 'cjs', write: false, external: ['react'],
      plugins: [{ name: 'taxonomy-image-boundary', setup(build) {
        build.onResolve({ filter: /^@\/assets\// }, args => ({ path: args.path, namespace: 'image' }));
        build.onLoad({ filter: /.*/, namespace: 'image' }, () => ({ contents: 'export default function Image(){return null;}' }));
      } }],
    });
    const target: { exports: Record<string, unknown> } = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(
      createRequire(path.resolve('package.json')), target, target.exports,
    );
    return { skills: target.exports.SKILL_CATEGORIES, interests: target.exports.INTEREST_CATEGORIES } as OnboardingTaxonomy;
  }

  test('actual UI category IDs resolve to canonical labels and remain separately attributable', async () => {
    const taxonomy = await displayedTaxonomy();
    const result = resolveOnboardingTaxonomy({
      skills: ['data', 'systems', 'data'], interests: ['machine learning', 'c++'],
      tech_stack: [' C++ ', 'React', 'React'],
    }, taxonomy);
    assert.deepEqual(result.skills, ['Data Engineering & AI/ML Pipelines', 'Systems & Embedded Programming']);
    assert.deepEqual(result.taxonomy_selections.skills.map(entry => entry.id), ['data', 'systems']);
    assert.deepEqual(result.interests, ['machine learning', 'c++']);
    assert.deepEqual(result.tech_stack, ['C++', 'React']);
    assert.equal(taxonomy.skills.find(entry => entry.id === 'data')?.title, result.skills[0]);
  });

  test('no selection is inferred and unknown or ambiguous IDs cannot become preferences', () => {
    const taxonomy = { skills: [{ id: 'data', title: 'Data Engineering' }], interests: [] };
    assert.deepEqual(resolveOnboardingTaxonomy({}, taxonomy), {
      taxonomy_selections: { skills: [], interests: [] }, skills: [], interests: [], tech_stack: [],
    });
    assert.throws(() => resolveOnboardingTaxonomy({ skills: ['invented'] }, taxonomy), /Unknown taxonomy/);
    assert.throws(() => resolveOnboardingTaxonomy({ interests: ['invented'] }, taxonomy), /Unknown taxonomy/);
    assert.throws(() => resolveOnboardingTaxonomy({}, {
      ...taxonomy, skills: [...taxonomy.skills, { id: 'data', title: 'Something Else' }],
    }), /Ambiguous taxonomy/);
    assert.throws(() => resolveOnboardingTaxonomy({ tech_stack: [' '] }, taxonomy), /nonempty technology/);
    assert.throws(() => resolveOnboardingTaxonomy({ skills: Array(51).fill('data') }, taxonomy), /at most 50/);
  });

  test('rendered step3 updates the onboarding draft so Back and Continue retain selected interests', async () => {
    const React = await import('react'); const { create } = await import('react-test-renderer');
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onboarding = loadSource('src/store/OnboardingContext.tsx', {});
    const save = { status: 'idle', message: null as string | null };
    let checks = 0;
    const Step3 = loadSource('src/app/onboarding/step3.tsx', {
      '@/components/keyboard/keyboard-layout': { KeyboardForm: 'KeyboardForm' },
      'react-native': { View: 'View', Text: 'Text' },
      '../../store/OnboardingContext': onboarding,
      '../../store/AuthContext': { useAuth: () => ({ completeOnboarding: async () => {}, checkOnboardingStatus: async () => {},
        onboardingSave: save, reconcileOnboarding: async () => { checks++; } }) },
      '../../utils/storage': { getItemAsync: async () => 'fixture' },
      '../../api/onboarding': { setupOnboarding: async () => ({ completed: true }) },
      ...Object.fromEntries(['ProgressBar', 'PrimaryButton', 'TechChip', 'LogoPlaceholder', 'StepHeader'].map(name => [
        `@/components/onboarding/${name}`, { __esModule: true, default: name },
      ])),
      '@/constants/onboarding': { INTEREST_CATEGORIES: [{ id: 'web', title: 'Web', interests: [{ id: 'react', name: 'React' }] }] },
    }).default;
    let updateDraft!: (data: unknown) => void;
    let draft: any, show!: (value: boolean) => void;
    function Flow() {
      const { data, updateData } = onboarding.useOnboarding(); draft = data; updateDraft = updateData;
      const [visible, setVisible] = React.useState(true); show = setVisible;
      React.useEffect(() => updateData({ skills: ['web'] }), [updateData]);
      return visible ? React.createElement(Step3) : null;
    }
    let root!: ReturnType<typeof create>;
    await React.act(async () => { root = create(React.createElement(onboarding.OnboardingProvider, null, React.createElement(Flow))); });
    try {
      await React.act(async () => root.root.findByType('TechChip').props.onPress());
      await React.act(async () => show(false));
      await React.act(async () => show(true));
      assert.deepEqual(draft.interests, ['react']);
      assert.equal(root.root.findByType('TechChip').props.selected, true);
      await React.act(async () => root.root.findByType('TechChip').props.onPress());
      assert.deepEqual(draft.interests, []);
      const retained = ['react', 'vue', 'angular', 'svelte', 'nextjs'];
      await React.act(async () => { updateDraft({ interests: retained }); show(false); });
      save.status = 'unknown'; save.message = 'Your preferences may have saved. Check save status.';
      await React.act(async () => show(true));
      assert.equal(root.root.findByProps({ title: 'Finish' }).props.disabled, true, 'an uncertain write must not enable a duplicate Finish');
      const check = root.root.findByProps({ title: 'Check save status' });
      await React.act(async () => check.props.onPress());
      assert.equal(checks, 1, 'the visible recovery action checks status rather than resubmitting');
      assert.deepEqual(draft.interests, retained, 'unknown outcomes retain the selections');
    } finally { await React.act(async () => root.unmount()); }
  });

  test('rendered skill and tech controls expose checked state and Space toggles only once', async t => {
    const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback => setTimeout(() => callback(performance.now()), 1)) as any;
    globalThis.cancelAnimationFrame = (handle => clearTimeout(handle)) as any;
    t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; });
    const React = await import('react'); const { create } = await import('react-test-renderer');
    const nativeRequire = createRequire(path.resolve('package.json'));
    // Real RN Web Pressable/Animated host rendering; icon rendering is unrelated.
    const web = nativeRequire('react-native-web');
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    for (const name of ['SkillCard', 'TechChip']) {
      const Control = loadSource(`src/components/onboarding/${name}.tsx`, {
        'react-native': web, 'lucide-react-native': { Check: () => null },
      }).default;
      let root!: ReturnType<typeof create>, presses = 0;
      function Selection() {
        const [selected, setSelected] = React.useState(false);
        return React.createElement(Control, { title: name, image: null, selected, onPress: () => { presses++; setSelected(value => !value); } });
      }
      await React.act(async () => { root = create(React.createElement(Selection)); });
      try {
        const host = () => root.root.findAllByType('div').find(node => node.props['aria-label'] === name)!;
        assert.ok(host(), 'selection controls need a stable accessible name');
        assert.equal(host().props.role, 'checkbox');
        assert.equal(host().props['aria-checked'], false);
        let prevented = false;
        // DOM event delivery needs Chromium. Here dispatch the RNW host's actual
        // key handler to protect Space support independently of that opt-in run.
        const event = { key: ' ', repeat: false, preventDefault() { prevented = true; }, stopPropagation() {},
          target: { getAttribute: (attribute: string) => attribute === 'role' ? 'checkbox' : null, tagName: 'DIV' } };
        await React.act(async () => host().props.onKeyDown(event));
        assert.equal(prevented, true);
        assert.equal(presses, 1);
        assert.equal(host().props['aria-checked'], true);
        await React.act(async () => host().props.onKeyDown({ ...event, repeat: true }));
        assert.equal(presses, 1, 'holding Space must not repeatedly toggle');
      } finally { await React.act(async () => root.unmount()); }
    }
  });
});
