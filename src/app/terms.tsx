import LegalScreen from '@/components/legal/LegalScreen';

export default function TermsScreen() {
  return (
    <LegalScreen
      title="Terms of Service"
      updated="July 19, 2026"
      sections={[
        {
          heading: 'Using Weave',
          paragraphs: [
            'Weave helps people discover and discuss open-source repositories. You must provide accurate account information, keep your credentials secure, and use the service only in compliance with applicable law.',
            'You may not abuse the service, interfere with its operation, scrape it at harmful rates, distribute malware, impersonate others, or use Weave to violate another person’s rights.',
          ],
        },
        {
          heading: 'Repository content',
          paragraphs: [
            'Repository descriptions, README files, statistics, and links may originate from GitHub or repository owners. Those materials remain subject to their respective licenses and terms. Weave does not grant additional rights to third-party code or content.',
          ],
        },
        {
          heading: 'Your contributions',
          paragraphs: [
            'You retain ownership of comments and profile information you provide. You grant Weave the limited permission required to store, display, moderate, and transmit that content as part of operating the service.',
          ],
        },
        {
          heading: 'Availability and enforcement',
          paragraphs: [
            'The service may change, experience interruptions, or discontinue features. Accounts or content may be restricted when necessary to protect users, comply with law, or enforce these terms.',
          ],
        },
        {
          heading: 'Disclaimers and liability',
          paragraphs: [
            'Weave is provided on an “as available” basis. Open-source projects can contain errors or security risks, so review repositories and their licenses before using them. To the extent permitted by law, Weave is not responsible for indirect or consequential loss arising from use of the service.',
          ],
        },
        {
          heading: 'Contact',
          paragraphs: [
            'Questions about these terms can be submitted through the support contact published with the Weave application or its official website.',
          ],
        },
      ]}
    />
  );
}
