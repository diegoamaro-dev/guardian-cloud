import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Top-level ErrorBoundary.
 *
 * A render error in any screen kills the whole React tree if nothing
 * catches it — testers get the white-screen-of-death (release) or the
 * red LogBox (dev) and the only escape is to force-stop the app. The
 * upload queue persists in AsyncStorage and the foreground service is
 * a separate process, so previously-recorded evidence is safe; we just
 * need a graceful surface that lets the user reopen the UI.
 *
 * Kept as a class component on purpose: error boundaries are still a
 * class-only API in React. No external library, no telemetry — those
 * are post-beta concerns. We log to console.error so the trace shows
 * up in Metro/logcat when reviewing tester reports.
 */

type Props = { children: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('ROOT_ERROR_BOUNDARY', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <View style={styles.container}>
        <Text style={styles.title}>La app encontró un error</Text>
        <Text style={styles.body}>
          Tu evidencia ya guardada está a salvo. Pulsa Reintentar para volver a
          la pantalla principal.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={this.reset}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        >
          <Text style={styles.buttonText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    paddingHorizontal: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 16,
    textAlign: 'center',
  },
  body: {
    color: '#cfcfcf',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 32,
  },
  button: {
    backgroundColor: '#3ddc84',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 999,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
});
