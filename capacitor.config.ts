import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'net.transcendiant.primordium',
  appName: 'Primordium',
  webDir: 'www',
  android: {
    allowMixedContent: false,
  },
};

export default config;
