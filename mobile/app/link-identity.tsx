/**
 * E1 — pantalla de vinculación diferida de identidad.
 *
 * PRESENTACIÓN Y ENTRADA. Nada más.
 *
 * Lo que esta pantalla NO hace, y no puede hacer sin romper E1:
 *   · no toca `GC_QUEUE` ni `queueMutate`;
 *   · no lee ni escribe la pausa (`pauseStore`, `client_auth`);
 *   · no decide recovery, no reanuda el worker, no limpia estado;
 *   · no inventa un veredicto: muestra el estado que `store.ts` deriva.
 *
 * De ahí que sus únicos imports de producto sean el store de Auth y la
 * primitiva de vinculación. Si algún día aparece aquí un import de la
 * cola, de la pausa o del uploader, la frontera se ha roto.
 *
 * La captura y la subida no dependen de esta pantalla: se puede grabar
 * sin email, y un fallo aquí no detiene nada.
 */

import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Stack } from 'expo-router';

import {
  deriveIdentityLinkState,
  linkEmail,
  useAuthStore,
  type LinkEmailFailure,
} from '@/auth/store';

/** Un fallo de Auth nunca se muestra como un fallo del sistema. */
const FAILURE_TEXT: Record<LinkEmailFailure, string> = {
  invalid_email: 'Esa dirección no parece válida. Revísala.',
  no_session: 'Todavía no hay identidad en este dispositivo.',
  network: 'No se pudo conectar. Inténtalo otra vez.',
  auth_non_retryable: 'No se pudo vincular esa dirección.',
  failed: 'No se pudo vincular esa dirección.',
  identity_changed: 'Algo no encaja. No se ha vinculado nada.',
  // No se confirma nada que el sistema no haya podido comprobar.
  no_user_returned: 'No hemos podido confirmarlo. Vuelve a intentarlo.',
};

export default function LinkIdentityScreen() {
  const user = useAuthStore((s) => s.user);
  const state = deriveIdentityLinkState(user);

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await linkEmail(email);
    if (!result.ok) setError(FAILURE_TEXT[result.reason]);
    setBusy(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#0d1117' }}>
      <Stack.Screen options={{ title: 'Recuperar acceso' }} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        {state === 'linked' ? (
          <Text style={{ color: '#e6edf3', fontSize: 16 }}>
            Tu correo está confirmado.
          </Text>
        ) : state === 'pending' ? (
          <Text style={{ color: '#e6edf3', fontSize: 16 }}>
            Te hemos enviado un correo. Ábrelo y confirma la dirección.
            {'\n\n'}
            Hasta que lo confirmes, esta dirección todavía no sirve para
            recuperar el acceso.
          </Text>
        ) : (
          <>
            <Text style={{ color: '#e6edf3', fontSize: 16 }}>
              Añade un correo para poder volver a entrar si pierdes el
              acceso en este teléfono.
            </Text>
            <Text style={{ color: '#8b949e', fontSize: 14 }}>
              No hace falta para grabar. Puedes hacerlo cuando quieras.
            </Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="tu@correo.com"
              placeholderTextColor="#6e7681"
              editable={!busy}
              style={{
                borderWidth: 1,
                borderColor: '#30363d',
                borderRadius: 8,
                color: '#e6edf3',
                padding: 12,
                fontSize: 16,
              }}
            />
            <Pressable
              onPress={onSubmit}
              disabled={busy}
              style={{
                backgroundColor: busy ? '#21262d' : '#238636',
                borderRadius: 8,
                padding: 14,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#ffffff', fontSize: 16 }}>
                {busy ? 'Enviando…' : 'Enviar correo de confirmación'}
              </Text>
            </Pressable>
          </>
        )}

        {error ? (
          <Text style={{ color: '#f85149', fontSize: 14 }}>{error}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
