import settings from '../config/settings.json' with { type: 'json' };

export interface Credentials {
  user: string;
  password: string;
}

/** The SMTP credentials come from the environment only; they are never written to disk. */
export function credentialsFromEnv(env: NodeJS.ProcessEnv): Credentials {
  const user = env['SMTP_USER'];
  const password = env['SMTP_PASSWORD'];
  if (user === undefined || password === undefined) throw new Error('SMTP credentials missing');
  return { user, password };
}

export function relayTarget(): string {
  return `${settings.smtpHost}:${settings.smtpPort}`;
}
