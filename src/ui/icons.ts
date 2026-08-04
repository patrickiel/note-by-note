/** Icon registry mapping app-level names to Lucide components.
 * Render via <Icon name="..." />. */
import AppWindow from '@lucide/svelte/icons/app-window';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import Bookmark from '@lucide/svelte/icons/bookmark';
import Box from '@lucide/svelte/icons/box';
import Check from '@lucide/svelte/icons/check';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import CircleDot from '@lucide/svelte/icons/circle-dot';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import CirclePlay from '@lucide/svelte/icons/circle-play';
import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
import Clock from '@lucide/svelte/icons/clock';
import Contrast from '@lucide/svelte/icons/contrast';
import Copy from '@lucide/svelte/icons/copy';
import Download from '@lucide/svelte/icons/download';
import EllipsisVertical from '@lucide/svelte/icons/ellipsis-vertical';
import ExternalLink from '@lucide/svelte/icons/external-link';
import FastForward from '@lucide/svelte/icons/fast-forward';
import File from '@lucide/svelte/icons/file';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import Code from '@lucide/svelte/icons/code';
import Github from '@/ui/shared/Github.svelte';
import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
import GripVertical from '@lucide/svelte/icons/grip-vertical';
import Heart from '@lucide/svelte/icons/heart';
import History from '@lucide/svelte/icons/history';
import Keyboard from '@lucide/svelte/icons/keyboard';
import LayoutGrid from '@lucide/svelte/icons/layout-grid';
import List from '@lucide/svelte/icons/list';
import ListMusic from '@lucide/svelte/icons/list-music';
import ListX from '@lucide/svelte/icons/list-x';
import LocateFixed from '@lucide/svelte/icons/locate-fixed';
import MessageCircleQuestionMark from '@lucide/svelte/icons/message-circle-question-mark';
import Minus from '@lucide/svelte/icons/minus';
import Moon from '@lucide/svelte/icons/moon';
import MoveHorizontal from '@lucide/svelte/icons/move-horizontal';
import Music from '@lucide/svelte/icons/music';
import Palette from '@lucide/svelte/icons/palette';
import Pause from '@lucide/svelte/icons/pause';
import Pencil from '@lucide/svelte/icons/pencil';
import Piano from '@lucide/svelte/icons/piano';
import Pin from '@lucide/svelte/icons/pin';
import Play from '@lucide/svelte/icons/play';
import Plus from '@lucide/svelte/icons/plus';
import Power from '@lucide/svelte/icons/power';
import Repeat from '@lucide/svelte/icons/repeat';
import Repeat1 from '@lucide/svelte/icons/repeat-1';
import Rewind from '@lucide/svelte/icons/rewind';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import Scissors from '@lucide/svelte/icons/scissors';
import Settings from '@lucide/svelte/icons/settings';
import Share2 from '@lucide/svelte/icons/share-2';
import Shield from '@lucide/svelte/icons/shield';
import SkipBack from '@lucide/svelte/icons/skip-back';
import Star from '@lucide/svelte/icons/star';
import Sun from '@lucide/svelte/icons/sun';
import Trash2 from '@lucide/svelte/icons/trash-2';
import Upload from '@lucide/svelte/icons/upload';
import Volume2 from '@lucide/svelte/icons/volume-2';
import VolumeX from '@lucide/svelte/icons/volume-x';
import X from '@lucide/svelte/icons/x';
import ZoomIn from '@lucide/svelte/icons/zoom-in';
import ZoomOut from '@lucide/svelte/icons/zoom-out';

export const ICONS = {
  // Header / global
  logo: Box,
  history: History,
  library: ListMusic,
  star: Star,
  starOutline: Star,
  share: Share2,
  power: Power,
  settings: Settings,
  close: X,
  pin: Pin,
  back: ArrowLeft,
  help: CircleQuestionMark,
  moreVert: EllipsisVertical,
  palette: Palette,

  // Panels
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  reset: RotateCcw,
  minus: Minus,
  plus: Plus,

  // Marker toolbar
  range: MoveHorizontal,
  scissors: Scissors,
  loop: Repeat,
  repeatSong: Repeat1,
  clock: Clock,
  zoomOut: ZoomOut,
  zoomIn: ZoomIn,
  follow: LocateFixed,
  pencil: Pencil,
  viewList: List,
  viewBlocks: LayoutGrid,
  bookmark: Bookmark,
  trash: Trash2,
  duplicate: Copy,
  dragHandle: GripVertical,

  // Transport
  play: Play,
  pause: Pause,
  record: CircleDot,
  skipToStart: SkipBack,
  rewind: Rewind,
  forward: FastForward,
  volume: Volume2,
  volumeMute: VolumeX,

  // Settings rows
  playCircle: CirclePlay,
  tabAudio: AppWindow,
  popup: ExternalLink,
  support: MessageCircleQuestionMark,
  keyboard: Keyboard,
  midi: Piano,
  clearAll: ListX,
  restore: RotateCcw,
  shield: Shield,
  download: Download,
  upload: Upload,
  grid: Grid3x3,
  check: Check,
  folderOpen: FolderOpen,
  file: File,
  heart: Heart,
  code: Code,
  github: Github,
  music: Music,

  // Misc
  themeAuto: Contrast,
  sun: Sun,
  moon: Moon,
  queueMusic: ListMusic,
} as const;

export type IconName = keyof typeof ICONS;

/** Names drawn with a solid fill, so they read as distinct from an outline sibling. */
export const FILLED_ICONS: ReadonlySet<IconName> = new Set<IconName>(['star', 'github']);
