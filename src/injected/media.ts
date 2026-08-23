import { installMediaBlocker, type MediaTargetLike } from '../core/patch';
import { report } from './report';

installMediaBlocker(window as unknown as MediaTargetLike, report);
