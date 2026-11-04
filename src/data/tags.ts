// Starter topic vocabulary with aliases. Placeholder seed: to be checked against the
// programme's track and keyword data once the feed is wired in.

export interface KnownTag {
  id: string;
  label: string;
  aliases: string[];
}

export const KNOWN_TAGS: readonly KnownTag[] = [
  { id: 'accessibility', label: 'Accessibility', aliases: ['a11y', 'assistive technology', 'disability', 'accessible', 'blind', 'deaf'] },
  { id: 'ai', label: 'AI and interaction', aliases: ['artificial intelligence', 'machine learning', 'ml', 'llm', 'llms', 'generative ai', 'human ai interaction'] },
  { id: 'ar', label: 'Augmented reality', aliases: ['ar', 'mixed reality', 'mr', 'xr'] },
  { id: 'vr', label: 'Virtual reality', aliases: ['vr', 'immersive', 'metaverse'] },
  { id: 'haptics', label: 'Haptics', aliases: ['touch feedback', 'tactile'] },
  { id: 'health', label: 'Health and wellbeing', aliases: ['health', 'wellbeing', 'well being', 'mental health', 'digital health'] },
  { id: 'education', label: 'Learning and education', aliases: ['education', 'learning', 'edtech', 'teaching'] },
  { id: 'visualization', label: 'Visualization', aliases: ['visualisation', 'vis', 'infovis', 'data visualization', 'data visualisation', 'dataviz'] },
  { id: 'games', label: 'Games and play', aliases: ['games', 'gaming', 'play', 'game design'] },
  { id: 'cscw', label: 'Collaboration and CSCW', aliases: ['cscw', 'collaboration', 'computer supported cooperative work', 'groupware'] },
  { id: 'social', label: 'Social computing', aliases: ['social media', 'online communities', 'social networks'] },
  { id: 'privacy', label: 'Privacy and security', aliases: ['privacy', 'security', 'usable security', 'usable privacy'] },
  { id: 'ethics', label: 'Ethics and values', aliases: ['ethics', 'values', 'responsible ai', 'fairness'] },
  { id: 'sustainability', label: 'Sustainability', aliases: ['climate', 'sustainable hci', 'environment'] },
  { id: 'fabrication', label: 'Fabrication and making', aliases: ['fabrication', 'digital fabrication', '3d printing', 'making', 'maker'] },
  { id: 'tangible', label: 'Tangible interfaces', aliases: ['tangible', 'tui', 'tangible user interfaces', 'physical computing'] },
  { id: 'wearables', label: 'Wearables', aliases: ['wearable', 'smartwatch', 'on body'] },
  { id: 'voice', label: 'Voice and conversational UI', aliases: ['voice', 'conversational agents', 'chatbots', 'speech interfaces', 'voice assistants'] },
  { id: 'input', label: 'Input and interaction techniques', aliases: ['interaction techniques', 'input', 'gestures', 'pointing', 'text entry'] },
  { id: 'ubicomp', label: 'Ubiquitous computing', aliases: ['ubicomp', 'iot', 'internet of things', 'smart home', 'pervasive computing'] },
  { id: 'design-methods', label: 'Design methods', aliases: ['research through design', 'participatory design', 'co design', 'codesign', 'speculative design'] },
  { id: 'ux-research', label: 'UX research', aliases: ['user research', 'usability', 'user studies', 'ux'] },
  { id: 'children', label: 'Children and families', aliases: ['children', 'kids', 'families', 'child computer interaction'] },
  { id: 'ageing', label: 'Ageing', aliases: ['aging', 'older adults', 'elderly'] },
  { id: 'creativity', label: 'Creativity and art', aliases: ['creativity', 'art', 'creative tools', 'music'] },
  { id: 'automotive', label: 'Automotive and mobility', aliases: ['automotive', 'cars', 'autonomous vehicles', 'mobility'] },
  { id: 'robots', label: 'Robots', aliases: ['robotics', 'hri', 'human robot interaction'] },
  { id: 'eye-tracking', label: 'Eye tracking', aliases: ['gaze', 'gaze interaction'] },
  { id: 'cognition', label: 'Cognition and perception', aliases: ['cognition', 'perception', 'attention', 'cognitive load'] },
  { id: 'global', label: 'Global and local contexts', aliases: ['hci4d', 'ictd', 'global south'] },
];
