// The component workshop: `npm run workbench` (needs a display) mounts the
// UI's own components in isolation — @react-x11/workbench, which is what
// Storybook is for a toolkit with no browser to put an iframe in.
//
// Stories live beside the app rather than inside `src/ui`, for the same
// reason `src/ui` is out of the core `tsconfig`: they depend on the optional
// react-x11 stack, and nothing the proxy ships imports them.
//
// x11vis follows the desktop's colour scheme (`PALETTE` + `DARK` in
// src/ui/controls.tsx), so every story file declares `theme: 'both'` and the
// workshop shows the light and the dark rendering side by side. Pin a file to
// one while working on it if the pair is in the way.
import { defineConfig } from '@react-x11/workbench';

export default defineConfig({
  stories: ['stories/**/*.story.tsx'],
  // The app's own geometry, so a panel can be previewed at the width it
  // actually gets: the window is 1240×780 with a 780px table pane, which
  // leaves the detail side ~460.
  sizes: {
    window: { width: 1240, height: 780 },
    bar: { width: 1180, height: 96 },
    detail: { width: 460, height: 700 },
  },
});
