import cactus from '../assets/icons/cactus.svg?raw';
import lawStar from '../assets/icons/law-star.svg?raw';
import pauseButton from '../assets/icons/pause-button.svg?raw';
import saloon from '../assets/icons/saloon.svg?raw';
import saloonDoors from '../assets/icons/saloon-doors.svg?raw';
import speaker from '../assets/icons/speaker.svg?raw';
import speakerOff from '../assets/icons/speaker-off.svg?raw';
import westernHat from '../assets/icons/western-hat.svg?raw';

// Icons by Delapouite, Lorc & Guard13007 — https://game-icons.net (CC BY 3.0). Fill is currentColor.
const ICONS = {
  cactus,
  'law-star': lawStar,
  'pause-button': pauseButton,
  saloon,
  'saloon-doors': saloonDoors,
  speaker,
  'speaker-off': speakerOff,
  'western-hat': westernHat,
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return <span className={className} style={{ display: 'inline-block' }} aria-hidden dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}
