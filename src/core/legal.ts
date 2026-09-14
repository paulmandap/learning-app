/**
 * Nomi's Terms of Use and Privacy Policy, as text (NOTES §40).
 *
 * The owner: *"please add/revise Terms of Use and Privacy Policy (yes, two
 * different things) and maybe follow a template/guide available on the internet
 * that is general, and then just add more based on what my app is for or what
 * my app does."*
 *
 * Built on the sections general templates share — Termly's privacy policy and
 * iubenda's terms of use — and written to what this app actually does, under
 * the Philippines' Data Privacy Act of 2012 (RA 10173). Decided by the owner on
 * 2026-09-14: the operator is Paul Christian Mandap, the contact is the Gmail
 * address below, Philippine law applies, and Nomi is for people 18 and older —
 * because Google's Gemini API terms say "You must be 18 years of age or older
 * to use the APIs", and every set Nomi makes goes through them.
 *
 * Kept here rather than in a screen so it can be read as text, and so the
 * claims about the app can be checked against the app (`tests/legal.test.ts`).
 * The one-time notice in `src/ui/privacy.tsx` is D13's short version and is
 * unchanged.
 *
 * Not legal advice, and not reviewed by a lawyer.
 */

export interface LegalSection {
  heading: string;
  /** In order. A string is a paragraph; an array is a bulleted list. */
  body: readonly (string | readonly string[])[];
}

export interface LegalDocument {
  title: string;
  effective: string;
  intro: string;
  sections: readonly LegalSection[];
}

export const OPERATOR = 'Paul Christian Mandap';
export const CONTACT_EMAIL = 'paulmandap16@gmail.com';
export const EFFECTIVE_DATE = 'September 14, 2026';
export const MINIMUM_AGE = 18;
/** How long an encrypted backup is kept — `retention-days` in .github/workflows/backup.yml. */
export const BACKUP_DAYS = 90;

export const PRIVACY_POLICY: LegalDocument = {
  title: 'Privacy Policy',
  effective: EFFECTIVE_DATE,
  intro:
    'This Privacy Policy explains what information Nomi collects, why, who it is shared with, and the choices and rights you have. Nomi is a study app that turns your notes into flashcards and quizzes, with Nomi, a study companion you can chat with. In this policy, "Nomi", "we", "us" and "our" mean ' +
    OPERATOR +
    ', who runs Nomi from the Philippines and is responsible for the personal information described here. "You" means the person using Nomi.',
  sections: [
    {
      heading: 'The short version',
      body: [
        [
          "Your notes, files and questions are sent to Google's Gemini AI service using your own Gemini key. On Google's free tier, Google may keep them to improve its products, and human reviewers at Google may read them. Please don't put anything sensitive into Nomi.",
          "We don't sell your information, show ads, or use advertising or tracking cookies.",
          'You can delete your data from Settings at any time, and ask us to delete your account.',
          `Nomi is for people ${MINIMUM_AGE} or older.`,
        ],
      ],
    },
    {
      heading: 'Information we collect',
      body: [
        'Information you give us:',
        [
          'Your email address, which is how you sign in. We send a 6-digit code to it; there is no password.',
          'The name you want to be called, your profile picture (a photo you upload, or one of the built-in faces), and the study pet you choose.',
          'Your Gemini key, which Nomi needs to make cards and to chat.',
        ],
        'What you study:',
        [
          'Notes you paste or write, and files you upload, such as PDFs and photos of pages, with the text read from them.',
          'The study sets, flashcards and quiz questions made from them, and any reviewer Nomi writes for you on a topic you name.',
          'Your answers, the marks and feedback they get, when each card is next due, and the days you studied.',
          'Your conversations with Nomi.',
        ],
        'Information collected automatically:',
        [
          'Records of signing in, kept by our sign-in provider, which can include your IP address, device and browser.',
          'A count of how many replies Nomi has given you each day, so the daily limit works.',
          'Standard web server logs kept by our hosting provider, such as IP addresses, browser type and the pages requested.',
        ],
        "Stored on your device: your signed-in session, whether you have read the privacy notice, and a copy of your profile picture so it appears quickly. Nomi doesn't use cookies or any similar technology for advertising, or to follow you across other websites.",
      ],
    },
    {
      heading: 'How we use your information',
      body: [
        [
          'To run Nomi: signing you in, making flashcards and quizzes from your notes, marking your written answers, scheduling reviews, showing your progress and streak, and letting you chat with Nomi.',
          'To send your study material and questions to Google\'s Gemini AI service when you make cards, answer written questions or chat — see "Google Gemini: where your notes go" below.',
          'To keep Nomi working and secure: preventing misuse, applying daily limits, fixing problems, and keeping backups.',
          'To reply when you contact us.',
        ],
        "We don't sell or rent your information, use it for advertising, or use it to make decisions about you that have legal or similarly significant effects.",
      ],
    },
    {
      heading: 'Why we are allowed to use it',
      body: [
        'Under the Data Privacy Act of 2012, we process your information because:',
        [
          'it is needed to give you Nomi, which you asked for when you signed up;',
          'you consent to it — for example, when you accept the privacy notice before your notes are first sent to Google, or when you upload a photo;',
          'it is needed for our legitimate interests in keeping Nomi secure, preventing misuse and keeping backups, where those interests are not outweighed by your rights.',
        ],
        "You can withdraw your consent at any time by deleting the information, using Delete my data, or contacting us. Withdrawing consent doesn't affect what was already done with it.",
      ],
    },
    {
      heading: 'Google Gemini: where your notes go',
      body: [
        "Nomi uses Google's Gemini AI service to read your files, make cards, write quiz choices, mark written answers, chat with you, and write reviewers. It does this with your own Gemini key, which you get from Google AI Studio.",
        'When Nomi does these things, what it needs is sent to Google: your notes and files, your questions and answers, and — when you chat with Nomi — what Nomi knows about your studying, such as your name, your sets, your streak and your progress.',
        "Google's free tier is covered by Google's own terms. Under them, Google may use what is sent to provide and improve its products and technology, and human reviewers at Google may read it. Google's Gemini API Additional Terms of Service and Google's Privacy Policy govern that use, not this policy.",
        "So please don't put patient information, other people's personal details, confidential work documents, or anything you wouldn't want a stranger to read into Nomi.",
        'When Nomi writes a reviewer on a topic, its facts come from Google\'s Gemini AI service, not from your own material, and can be wrong. It is saved in your Notes so you can check and correct it.',
      ],
    },
    {
      heading: 'Who we share information with',
      body: [
        'We share information only with the service providers who run parts of Nomi for us, and only as much as they need to do it:',
        [
          'Supabase — our database, file storage and sign-in, including sending your sign-in codes.',
          'Cloudflare — hosts the Nomi web app.',
          "Google — the Gemini AI service, as described above, through your own key.",
          'GitHub — stores an encrypted monthly backup of the database.',
        ],
        'We may also share information if the law requires it, to answer a lawful request from public authorities, or to protect the rights, safety or property of Nomi, its users or others.',
      ],
    },
    {
      heading: 'Where your information is stored',
      body: [
        "Our service providers store and process information on servers that may be outside the Philippines, including in the United States. When information is transferred abroad, we rely on those providers' own security and data protection commitments, and we remain responsible for it under the Data Privacy Act of 2012.",
      ],
    },
    {
      heading: 'How long we keep it',
      body: [
        [
          'Your profile, study material, answers, notes and conversations are kept until you delete them or use Delete my data.',
          "Delete my data removes your sets, uploaded files, cards, answers, review schedule, the days you studied, the daily count of Nomi's replies, your notes, your conversations with Nomi and your profile picture, and clears your name and Gemini key. It does not remove your account itself — your email address and sign-in record. To remove those too, email us.",
          `Backups are encrypted, and each one is kept for ${BACKUP_DAYS} days, so something you delete can remain in a backup for up to ${BACKUP_DAYS} days before it is gone.`,
          "What Google receives through your key is kept according to Google's terms, and server logs according to our providers' own policies.",
        ],
      ],
    },
    {
      heading: 'How we protect it',
      body: [
        'We use reasonable organisational, physical and technical measures to protect your information, including encrypted connections, database rules that let each account reach only its own information, private storage for uploaded files and profile pictures, and encrypted backups.',
        'Your Gemini key is saved to your account, and the app lets only you read it. The person who runs Nomi can technically reach the database, and does so only to keep Nomi working, to fix a problem you report, or where the law requires it.',
        "No way of storing or sending information over the internet is completely secure, so we can't promise absolute security. If a breach of personal information happens that is likely to put you at risk, we will tell you and the National Privacy Commission within 72 hours of learning of it, as the law requires.",
      ],
    },
    {
      heading: 'Your rights',
      body: [
        'Under the Data Privacy Act of 2012, you have the right to:',
        [
          'be informed of how your personal information is collected and used — which is what this policy is for;',
          'access your personal information and get a copy of it;',
          'object to its use, and withdraw your consent;',
          'have information that is wrong or incomplete corrected;',
          'have it blocked, removed or destroyed;',
          'get it in a structured, commonly used electronic format, and have it sent to another service;',
          'be paid damages if you are harmed by information about you that is wrong, unlawfully obtained or used without permission;',
          'file a complaint with the National Privacy Commission (privacy.gov.ph).',
        ],
        `Much of this you can do yourself in Nomi: change your name and picture in Settings, edit or delete your notes and sets, remove your Gemini key, and use Delete my data. For anything else — a copy of your information, or deleting your account — email ${CONTACT_EMAIL}. We may need to confirm it is you, and we will reply within 30 days. If you live outside the Philippines, your local law may give you similar rights; contact us the same way.`,
      ],
    },
    {
      heading: `Nomi is for people ${MINIMUM_AGE} and older`,
      body: [
        `Nomi is for people ${MINIMUM_AGE} or older. This follows Google's terms for the Gemini AI service Nomi depends on, which require its users to be at least ${MINIMUM_AGE}. We don't knowingly collect information from anyone under ${MINIMUM_AGE}. If you believe someone under ${MINIMUM_AGE} is using Nomi, email us and we will delete their information.`,
      ],
    },
    {
      heading: 'Other websites',
      body: [
        "Nomi links to other services, such as Google AI Studio, where you get a Gemini key. Their own privacy policies apply there, and we aren't responsible for them.",
      ],
    },
    {
      heading: 'Changes to this policy',
      body: [
        "We may update this policy when Nomi changes. The date at the top shows when it last changed. If a change is significant, we'll let you know in the app.",
      ],
    },
    {
      heading: 'Contact us',
      body: [
        `Questions, requests or complaints about your privacy: ${OPERATOR}, ${CONTACT_EMAIL}. Nomi is run from the Philippines.`,
      ],
    },
  ],
};

export const TERMS_OF_USE: LegalDocument = {
  title: 'Terms of Use',
  effective: EFFECTIVE_DATE,
  intro:
    'These Terms of Use are an agreement between you and ' +
    OPERATOR +
    ', who runs Nomi ("Nomi", "we", "us"). They cover your use of the Nomi web app. By signing in or using Nomi, you agree to them. If you don\'t agree, please don\'t use Nomi.',
  sections: [
    {
      heading: 'Who can use Nomi',
      body: [
        [
          `You must be ${MINIMUM_AGE} or older. Nomi uses Google's Gemini AI service, whose terms require its users to be at least ${MINIMUM_AGE}.`,
          'You need an email address that can receive sign-in codes, and your own Gemini key from Google.',
          'Your account is for you alone. Keep access to your email secure, and tell us if you think someone else has used your account.',
        ],
      ],
    },
    {
      heading: 'What Nomi does',
      body: [
        'Nomi turns your notes and files into flashcards and quizzes, marks your written answers, schedules reviews, tracks your progress, lets you chat with Nomi, a study companion, and can write a reviewer on a topic you name. Nomi is free. We may add, change or remove features at any time.',
      ],
    },
    {
      heading: 'Your Gemini key',
      body: [
        [
          'Nomi works through your own Gemini key, so what Nomi sends to Google counts against your own Google account.',
          "Your use of Gemini through Nomi is also covered by Google's terms, including the Gemini API Additional Terms of Service, and you are responsible for following them.",
          "Google's free tier has usage limits. If you use a key with billing turned on, any charges from Google are yours.",
          'You can remove your key in Settings at any time.',
        ],
      ],
    },
    {
      heading: 'Your content',
      body: [
        [
          'You own the notes, files and other material you put into Nomi ("your content").',
          `You give us permission to store, copy, process and display your content, and to send it to Google's Gemini AI service, only as needed to run Nomi for you. This permission ends when you delete the content, apart from copies that remain in encrypted backups for up to ${BACKUP_DAYS} days.`,
          'You are responsible for your content. Only upload material you have the right to use — for example your own notes, or material your school or teacher lets you use for studying.',
          "Don't put sensitive information into Nomi, such as patient information, other people's personal details or confidential documents. Our Privacy Policy explains why.",
        ],
      ],
    },
    {
      heading: 'Using Nomi responsibly',
      body: [
        'When you use Nomi, you agree not to:',
        [
          'break any law, or use Nomi for anything harmful, fraudulent or abusive;',
          "upload material that infringes someone else's copyright or other rights, or that is illegal, hateful, sexually explicit or violent;",
          "try to reach another person's account or information, or get around Nomi's security or limits;",
          'upload viruses or other harmful code, or interfere with or overload Nomi;',
          'copy, scrape, resell or reverse-engineer Nomi, or use automated tools to access it;',
          "use Nomi to cheat in exams or coursework where your school doesn't allow it.",
        ],
      ],
    },
    {
      heading: 'What AI makes can be wrong',
      body: [
        [
          "Flashcards, quiz questions, marks, feedback, Nomi's replies and reviewers are made with Google's Gemini AI service. They can be inaccurate, incomplete or out of date.",
          'Always check what you study against your own course materials.',
          'Marks and feedback in Nomi are study aids, not official grades.',
          'Nothing in Nomi is professional advice — medical, legal, financial or otherwise.',
        ],
      ],
    },
    {
      heading: "Nomi's own content",
      body: [
        `Nomi — its name, the Nomi owl character and logo, its design and its software — belongs to ${OPERATOR}. You may use Nomi for your own studying, but you may not copy, change or distribute any part of it without permission. This doesn't cover your content, which stays yours.`,
      ],
    },
    {
      heading: 'Other services',
      body: [
        "Nomi relies on services run by others, including Google, Supabase and Cloudflare. We don't control them and aren't responsible for their availability, content or practices.",
      ],
    },
    {
      heading: 'Availability',
      body: [
        "We work to keep Nomi running, but it is free and we can't promise it will always be available, free of errors, or secure. We may pause Nomi for maintenance, change it, or stop offering it. If we decide to shut Nomi down, we'll try to give you reasonable notice. Keep your own copies of notes that matter to you.",
      ],
    },
    {
      heading: 'Ending your use',
      body: [
        'You can stop using Nomi at any time, and delete your data in Settings. We may suspend or end your access if you break these terms, if the law requires it, or to protect Nomi or other users. The parts of these terms about your content, disclaimers, limits on liability and governing law continue to apply after your access ends.',
      ],
    },
    {
      heading: 'Disclaimers',
      body: [
        "As far as the law allows, Nomi is provided \"as is\" and \"as available\", without warranties of any kind, express or implied — including that it is accurate, uninterrupted, or fit for a particular purpose. We don't promise that using Nomi will improve your results in any exam or course.",
      ],
    },
    {
      heading: 'Limits on our liability',
      body: [
        "As far as the law allows, we aren't liable for indirect, incidental, special or consequential damages, or for lost data, lost study time, or exam or course results, arising from your use of Nomi. Our total liability for any claim about Nomi is limited to ₱1,000 (one thousand Philippine pesos). Nothing in these terms limits liability that cannot be limited under Philippine law, such as liability for fraud.",
      ],
    },
    {
      heading: 'Your responsibility for misuse',
      body: [
        'You agree to cover claims, losses and costs, including reasonable legal fees, that arise from your content, or from your breaking these terms or the law.',
      ],
    },
    {
      heading: 'Privacy',
      body: [
        'Our Privacy Policy explains how we collect and use your information. By using Nomi, you acknowledge that you have read it.',
      ],
    },
    {
      heading: 'Changes to these terms',
      body: [
        "We may update these terms. The date at the top shows when they last changed. If a change is significant, we'll let you know in the app. If you keep using Nomi after a change, you accept the updated terms.",
      ],
    },
    {
      heading: 'Governing law and disputes',
      body: [
        "These terms are governed by the laws of the Republic of the Philippines. If you have a problem with Nomi, please email us first — most things can be sorted out that way. A dispute that can't be resolved informally will be brought before the proper courts of the Philippines.",
      ],
    },
    {
      heading: 'General',
      body: [
        [
          "If any part of these terms can't be enforced, the rest still applies.",
          "If we don't enforce part of these terms, we haven't given up the right to.",
          'These terms and the Privacy Policy are the whole agreement between you and us about Nomi.',
          "You can't transfer your rights under these terms to anyone else.",
        ],
      ],
    },
    {
      heading: 'Contact us',
      body: [`Questions about these terms: ${OPERATOR}, ${CONTACT_EMAIL}.`],
    },
  ],
};
