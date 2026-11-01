/**
 * English for the interface, keyed by the French text the code is written in (see `i18n.ts`).
 * One file per part of the app.
 */
import { ACCOUNT } from './account';
import { CAREER } from './career';
import { CAREER_SCENE } from './career-scene';
import { CAREER_SCREEN } from './career-screen';
import { LESSONS } from './lessons';
import { MAIN } from './main';
import { SCREENS } from './screens';

export const EN: Record<string, string> = { ...MAIN, ...SCREENS, ...CAREER, ...CAREER_SCREEN, ...CAREER_SCENE, ...LESSONS, ...ACCOUNT };
