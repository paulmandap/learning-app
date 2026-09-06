/**
 * Static image imports.
 *
 * Metro turns `import pet from './pet-1.png'` into an asset reference at build
 * time, but TypeScript knows nothing about it: `expo/types` (referenced by
 * `expo-env.d.ts`) does not declare image modules, so the import is an error
 * until something says what a `.png` is. This is that something.
 *
 * Typed as `ImageSourcePropType` rather than `any`, so passing one to anything
 * that is not an image source is still caught.
 *
 * Not in `expo-env.d.ts`, which is generated and carries "should not be
 * edited" at the top.
 */
declare module '*.png' {
  import type { ImageSourcePropType } from 'react-native';
  const content: ImageSourcePropType;
  export default content;
}

declare module '*.jpg' {
  import type { ImageSourcePropType } from 'react-native';
  const content: ImageSourcePropType;
  export default content;
}

declare module '*.svg' {
  import type { ImageSourcePropType } from 'react-native';
  const content: ImageSourcePropType;
  export default content;
}

/** The pet frames. See scripts/make-pet-assets.ts for why they are not PNGs. */
declare module '*.webp' {
  import type { ImageSourcePropType } from 'react-native';
  const content: ImageSourcePropType;
  export default content;
}
