import LegalScreen from '@/components/legal/LegalScreen';

export default function PrivacyScreen() {
  return (
    <LegalScreen
      title="Privacy Policy"
      updated="July 19, 2026"
      sections={[
        {
          heading: 'Information we process',
          paragraphs: [
            'Weave processes account identifiers, email address, profile details, connected GitHub information, repositories you view or save, reactions, comments, onboarding interests, device and session identifiers, and basic diagnostic information.',
          ],
        },
        {
          heading: 'How information is used',
          paragraphs: [
            'We use this information to authenticate users, provide social features, personalize repository recommendations, measure feed quality, prevent abuse, troubleshoot failures, and improve Weave.',
            'Interaction signals such as impressions, dwell time, likes, dislikes, saves, and README opens may be used to update recommendation profiles.',
          ],
        },
        {
          heading: 'Service providers',
          paragraphs: [
            'Weave relies on infrastructure and identity providers that may include GitHub, Google, Supabase, database and cache hosting, vector-search infrastructure, and application hosting. They process information only as needed to provide their services under their own terms.',
          ],
        },
        {
          heading: 'Storage and security',
          paragraphs: [
            'We use access controls, encrypted transport, short-lived access tokens, restricted service credentials, and other safeguards appropriate to the service. No internet service can guarantee absolute security.',
          ],
        },
        {
          heading: 'Retention and choices',
          paragraphs: [
            'Information is retained while needed to provide the service, satisfy legal obligations, resolve disputes, and protect the platform. You may request access, correction, export, or deletion through the support contact published with the application.',
          ],
        },
        {
          heading: 'Updates and contact',
          paragraphs: [
            'Material policy changes will be reflected by an updated date and, when appropriate, an in-product notice. Privacy questions can be submitted through the support contact published with the Weave application or its official website.',
          ],
        },
      ]}
    />
  );
}
