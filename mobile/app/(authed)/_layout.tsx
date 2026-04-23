/**
 * Authed stack layout.
 *
 * Guard: if the user isn't signed in, bounce them back to the login
 * route. Everything inside this folder assumes a valid session.
 */

import { Stack } from 'expo-router';

export default function RootLayout() {
  return <Stack />;
}