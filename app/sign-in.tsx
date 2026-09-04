import { useState } from 'react';
import { Body, Button, Card, Field, Notice, Screen, Title } from '../src/ui/components';
import { supabase } from '../src/data/supabase';

/**
 * Email + six-digit code (D10). No passwords, no magic links.
 *
 * Magic links open in the system browser rather than the installed PWA, so the
 * session lands somewhere the user isn't. A typed code always lands in the
 * window that asked for it — which is why this is the only sign-in method.
 */
export default function SignIn() {
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    const address = email.trim();
    if (!address.includes('@')) {
      setError('Enter your email address.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (err) {
      setError("We couldn't send the code. Check the address and try again.");
      return;
    }
    setStage('code');
  }

  async function verify() {
    const digits = code.trim();
    if (digits.length !== 6) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: digits,
      type: 'email',
    });
    setBusy(false);
    if (err) {
      setError("That code didn't work. It may have expired — send a new one.");
      return;
    }
    // The auth listener in the root layout redirects on success.
  }

  return (
    <Screen>
      <Title>Study</Title>
      <Card>
        {stage === 'email' ? (
          <>
            <Body>Enter your email and we'll send you a 6-digit code to sign in.</Body>
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
            />
            <Button label="Send me a code" onPress={sendCode} busy={busy} />
          </>
        ) : (
          <>
            <Body>We sent a 6-digit code to {email.trim()}. Enter it below.</Body>
            <Field
              label="6-digit code"
              value={code}
              onChangeText={setCode}
              placeholder="123456"
              keyboardType="number-pad"
              maxLength={6}
            />
            <Button label="Sign in" onPress={verify} busy={busy} />
            <Button
              label="Use a different email"
              variant="secondary"
              onPress={() => {
                setStage('email');
                setCode('');
                setError(null);
              }}
            />
          </>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Card>
    </Screen>
  );
}
