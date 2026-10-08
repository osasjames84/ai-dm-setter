/**
 * Public legal pages: Privacy Policy, Terms of Service and Data Deletion
 * instructions. Meta App Review checks these URLs, so they name exactly what
 * the app keeps, why, who processes it, for how long, and how to get it deleted.
 *
 * The operator's identity comes from env (COMPANY_NAME, COMPANY_EMAIL,
 * COMPANY_ADDRESS, COMPANY_NUMBER, COMPANY_ICO_NUMBER, HOSTING_PROVIDER). Unset
 * values render as a visible [placeholder] so a missing detail is obvious before
 * submission. Copy is plain English, written for UK GDPR, with no em dashes.
 */

export const LEGAL_UPDATED = '8 October 2026';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Operator details from env, HTML-escaped, with placeholders when unset. */
export function companyInfo(env = process.env) {
  const v = (k, placeholder) => {
    const raw = String(env[k] || '').trim();
    return raw ? { text: esc(raw), set: true } : { text: `<span class="ph">[${placeholder}]</span>`, set: false };
  };
  const email = v('COMPANY_EMAIL', 'COMPANY_EMAIL not set: add the contact email');
  return {
    name: v('COMPANY_NAME', 'COMPANY_NAME not set: add the registered company name'),
    email,
    emailLink: email.set ? `<a href="mailto:${email.text}">${email.text}</a>` : email.text,
    address: v('COMPANY_ADDRESS', 'COMPANY_ADDRESS not set: add the registered office address'),
    number: v('COMPANY_NUMBER', 'COMPANY_NUMBER not set: add the Companies House number'),
    ico: String(env.COMPANY_ICO_NUMBER || '').trim() ? esc(env.COMPANY_ICO_NUMBER) : null,
    hosting: esc(String(env.HOSTING_PROVIDER || '').trim() || 'Railway Corporation (cloud hosting, United States)'),
    product: esc(String(env.PRODUCT_NAME || '').trim() || 'dmSetter'),
  };
}

/**
 * Wrap sections in a standalone, readable page. A section body may be a string
 * (one paragraph, trusted HTML) or an array of strings (a bullet list).
 */
export function legalPage(title, sections, opts = {}) {
  const body = sections.map(([h, p]) => {
    const content = Array.isArray(p) ? '<ul>' + p.map((li) => `<li>${li}</li>`).join('') + '</ul>' : `<p>${p}</p>`;
    return `<h2>${h}</h2>${content}`;
  }).join('');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + '<style>body{font-family:Inter,system-ui,sans-serif;background:#171a21;color:#e9eaed;margin:0;padding:48px 20px;line-height:1.65}'
    + 'main{max-width:720px;margin:0 auto}h1{color:#f9fafa;font-size:26px;margin:0 0 6px}h2{color:#f9fafa;font-size:17px;margin:28px 0 6px}'
    + 'p,li{color:#b5b9c2;margin:0 0 6px}ul{padding-left:20px;margin:0}.upd{color:#7b8090;font-size:13px;margin-bottom:8px}a{color:#8c9aff}'
    + '.ph{color:#ffb4a8;font-weight:600}nav{margin-top:36px;font-size:14px}nav a{margin-right:16px}</style></head>'
    + `<body><main><h1>${esc(title)}</h1>${opts.plain ? '' : `<p class="upd">Last updated: ${LEGAL_UPDATED}</p>`}${body}`
    + (opts.plain ? '' : '<nav><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/data-deletion">Data Deletion</a></nav>')
    + '</main></body></html>';
}

/** The Privacy Policy page. */
export function privacyPage(env = process.env) {
  const c = companyInfo(env);
  const optional = [];
  if (env.SENTRY_DSN) optional.push('<b>Functional Software, Inc. (Sentry)</b>, error monitoring. Error reports are kept free of message text where possible. United States.');
  if (env.BACKUP_S3_BUCKET) optional.push('<b>Our off-site backup storage provider</b> (S3 compatible object storage), encrypted database backups kept for no more than 30 days.');
  return legalPage('Privacy Policy', [
    ['Who we are', `${c.product} is operated by ${c.name.text}, a company registered in England and Wales (company number ${c.number.text}), registered office ${c.address.text}. You can contact us about privacy at ${c.emailLink}.${c.ico ? ` We are registered with the Information Commissioner's Office (ICO), registration number ${c.ico}.` : ''}`],
    ['What this service does', `${c.product} helps a business read and answer the Instagram direct messages people send to its own Instagram professional account. It uses only Meta's official Instagram Platform (the Instagram API with Instagram Login), with the permissions instagram_business_basic and instagram_business_manage_messages. Replies may be drafted by AI. The business either approves each reply or sets the conversation to send replies automatically. The service only ever replies to people who messaged the business first, and only within the 24 hours Instagram allows after their last message.`],
    ['Who this policy covers', [
      '<b>Leads</b>: people who send a direct message to a business that uses ' + c.product + '. For these conversations the business is the data controller and we process the data on its behalf as its data processor.',
      '<b>Customers</b>: the businesses and their team members who use ' + c.product + '. For customer account data we are the data controller.',
    ]],
    ['The data we keep', [
      '<b>Conversations</b>: the text of each Instagram direct message sent to or from the connected business account, with its date and time.',
      '<b>Media in conversations</b>: photos, voice notes, videos and files sent in a conversation, stored as copies because Instagram links expire. Voice notes may be transcribed into text, and photos may be given a short text description, so the business and the AI can read them.',
      '<b>Instagram identifiers</b>: the Instagram scoped user ID of each person who messages the business, and their Instagram username and profile name when Instagram provides them. We do not store profile pictures.',
      '<b>AI generated content</b>: draft replies, suggested pipeline stages, review flags, and (if the business turns it on) a short lead profile note such as the goal and obstacles a lead mentioned.',
      '<b>Booking information</b>: if the business connects Calendly, the date and time of a booked call and whether it was booked or cancelled. The invitee name and booking answers Calendly sends are used only to match the booking to the right conversation and are not stored.',
      '<b>Customer account data</b>: team member email addresses, sign-in sessions, settings, reply scripts, uploaded knowledge documents, usage records, and the Instagram access token (encrypted with AES-256-GCM).',
      '<b>Technical records</b>: for each message we send, the Instagram message id, a one way hash of the text and its delivery state (used to prevent duplicate sends), and the ids of incoming webhook events (used to ignore repeats). Server logs do not contain message text.',
    ]],
    ['Why we use it and our lawful basis', [
      'To provide the service the business asked for: show its conversations, draft replies, and send replies it approved or set to send automatically. For leads, the business relies on its legitimate interests in answering messages people chose to send it. For customers, the basis is our contract with them.',
      'To keep the service safe and within Instagram rules: enforcing the 24 hour messaging window and send limits, preventing duplicate messages, security and abuse prevention. Basis: legitimate interests and legal obligations.',
      'We do not sell personal data, we do not use it for advertising, and it is not used to train AI models.',
    ]],
    ['Who processes it for us (sub-processors)', [
      '<b>Meta Platforms (Instagram)</b>, the messaging platform the conversations happen on. Meta Platforms Ireland Ltd and Meta Platforms, Inc.',
      '<b>Anthropic PBC</b>, AI that drafts replies, describes photos and writes lead profile notes. Under Anthropic\'s commercial terms, API data is not used to train its models. United States.',
      `<b>${c.hosting}</b>, hosts our servers and database.`,
      '<b>Groq, Inc. or OpenAI, L.L.C.</b> (optional), transcribes voice notes into text, only when the business adds a transcription key. United States.',
      '<b>Resend (Plus Five Five, Inc.)</b>, sends sign-in links and notification emails to customers. United States.',
      '<b>Calendly LLC</b> (optional), booking calls, only when the business connects Calendly. United States.',
      ...optional,
    ]],
    ['International transfers', 'Some of these providers are in the United States. Where personal data leaves the UK we rely on the UK Extension to the EU-US Data Privacy Framework where the provider is certified, or on the UK International Data Transfer Addendum to the EU Standard Contractual Clauses.'],
    ['How long we keep it', [
      'Conversations, media, drafts and lead profile notes: for as long as the business keeps its ' + c.product + ' account, unless the business or the lead asks for deletion sooner. On deletion they are removed from the live database straight away.',
      'Backups: daily database backups are kept for 7 days, so deleted data leaves the backups within 7 days.',
      'Send records: 30 days. Webhook event ids: 7 days.',
      'Instagram access token: until the business disconnects Instagram, removes the app in Instagram, or deletes its account, at which point it is erased.',
      'Customer account data: until the customer deletes the account. Server logs: up to 30 days with our hosting provider.',
    ]],
    ['How to get your data deleted', [
      `<b>If you messaged a business that uses ${c.product}</b>: email ${c.emailLink} with your Instagram username and the business you messaged, or ask the business directly. We delete the conversation, its media and drafts within one month at the latest, and usually within 7 days. Full instructions are on the <a href="/data-deletion">Data Deletion page</a>.`,
      '<b>If you are a customer</b>: delete your workspace in Settings (this removes everything at once), or remove the app from your Instagram account under Settings, Apps and websites. Meta then sends us a deletion request and we erase your Instagram connection and its conversations automatically.',
    ]],
    ['Your rights', `Under UK GDPR you can ask for a copy of your data, ask us to correct or delete it, object to or restrict how it is used, and ask for it in a portable format. Contact ${c.emailLink}. If you are a lead, we will pass your request to the business that controls your conversation and help it respond. You can also complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk</a> or on 0303 123 1113.`],
    ['Security', 'All traffic uses HTTPS. Instagram tokens are encrypted at rest. Access to the system is limited to the business\'s own signed in team members and to us for support and maintenance.'],
    ['Children', `${c.product} is not meant for children. Instagram requires users to be at least 13, and businesses must not use ${c.product} to target children.`],
    ['Changes', 'If we change this policy we will update the date at the top of this page and, for material changes, tell customers by email.'],
  ]);
}

/** The Terms of Service page. */
export function termsPage(env = process.env) {
  const c = companyInfo(env);
  return legalPage('Terms of Service', [
    ['About these terms', `These terms apply to your use of ${c.product}, operated by ${c.name.text} (company number ${c.number.text}), registered office ${c.address.text}, contact ${c.emailLink}. By creating an account or connecting an Instagram account you agree to them.`],
    ['The service', `${c.product} lets a business manage the Instagram direct messages sent to its own Instagram professional account: read conversations, get AI drafted replies, approve them, or let them send automatically. It works only through Meta's official Instagram Platform.`],
    ['Your responsibilities', [
      'You must own or be authorised to manage the Instagram professional account you connect.',
      'You must follow Meta\'s Platform Terms, the Instagram Terms of Use and Community Guidelines, and the law, including UK GDPR and consumer and advertising rules.',
      `You are responsible for the scripts, rules and messages you set up and for anything sent from your account through ${c.product}.`,
      'You must not use the service to send spam, unsolicited bulk messages, or messages to people who have not contacted you first.',
      'If someone asks you to stop messaging them or to delete their data, you must honour it. We will help.',
    ]],
    ['Built in limits', `${c.product} only replies to people who messaged your account first and only within the 24 hours Instagram allows after their last message. It spaces out messages and caps how many it sends each hour. It never uses message tags to get around these rules. When a message cannot be sent within these limits it is held for you to review instead.`],
    ['AI drafted replies', 'Replies may be written by AI and can be wrong. You can review every reply before it is sent, and you are responsible for the replies you approve or allow to send automatically.'],
    ['Data protection', `Our <a href="/privacy">Privacy Policy</a> explains what we keep and why. For your leads' conversations you are the data controller and we act as your processor, processing them only to provide the service on your instructions.`],
    ['Suspension and ending', 'You can stop using the service and delete your workspace at any time. We may suspend an account that breaks these terms or Meta\'s rules, or that puts other users at risk. When an account is deleted its data is erased as described in the Privacy Policy.'],
    ['Liability', 'The service is provided as is. To the extent the law allows, we are not liable for indirect or consequential losses or for lost profits, and our total liability is limited to the fees you paid us in the 12 months before the claim. Nothing in these terms limits liability for death or personal injury caused by negligence, for fraud, or for anything that cannot be limited by law.'],
    ['Law', 'These terms are governed by the law of England and Wales and the courts of England and Wales have jurisdiction.'],
    ['Contact', `Questions about these terms: ${c.emailLink}.`],
  ]);
}

/** Data Deletion instructions page (Meta accepts this URL or the signed callback). */
export function dataDeletionPage(env = process.env, code = '') {
  const c = companyInfo(env);
  const clean = String(code || '').replace(/[^a-f0-9]/gi, '').slice(0, 16);
  return legalPage('Data Deletion', [
    ...(clean ? [['Status of your request', `Deletion request <b>${clean}</b> has been completed. The Instagram connection and the conversations it covered were erased from our live database, and they leave our backups within 7 days.`]] : []),
    ['If you messaged a business that uses ' + c.product, [
      `Email ${c.emailLink} with the subject "Delete my data", your Instagram username, and the Instagram account you messaged.`,
      'Or send the business a direct message asking it to delete your conversation. The business can erase it from its inbox.',
      'We confirm by email once it is done: the conversation, any photos, voice notes or videos you sent, transcripts, AI drafts and notes about you are deleted from the live database within one month at the latest (usually within 7 days), and from backups 7 days after that.',
    ]],
    ['If you are a business using ' + c.product, [
      'Delete your workspace in Settings. Everything it holds is erased immediately.',
      'Or remove the app from your Instagram account: Instagram app, Settings, Apps and websites, then remove it. Meta sends us a signed deletion request and we erase the Instagram connection and its conversations automatically. You get a confirmation code you can check on this page.',
      `Or email ${c.emailLink} and we will do it for you.`,
    ]],
    ['Questions', `Contact ${c.emailLink}. ${c.name.text}, ${c.address.text}.`],
  ]);
}
