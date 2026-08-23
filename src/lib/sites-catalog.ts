export type SiteStatus = "supported" | "limited";

export type CatalogSite = {
  id: string;
  name: string;
  domain: string;
  category: "video" | "social" | "news" | "direct" | "other";
  status: SiteStatus;
  notes?: string;
};

export const SITE_CATALOG: CatalogSite[] = [
  {
    id: "direct",
    name: "Direct media files",
    domain: "direct file URLs",
    category: "direct",
    status: "supported",
    notes: "MP4, WebM, MKV, MOV, M4A, MP3 and similar direct file links.",
  },
  {
    id: "archive",
    name: "Internet Archive",
    domain: "archive.org",
    category: "video",
    status: "supported",
  },
  {
    id: "youtube",
    name: "YouTube",
    domain: "youtube.com",
    category: "video",
    status: "limited",
    notes: "May require additional verification depending on the source.",
  },
  {
    id: "vimeo",
    name: "Vimeo",
    domain: "vimeo.com",
    category: "video",
    status: "limited",
    notes: "Some videos require a signed-in session.",
  },
  {
    id: "dailymotion",
    name: "Dailymotion",
    domain: "dailymotion.com",
    category: "video",
    status: "limited",
  },
  {
    id: "twitch",
    name: "Twitch",
    domain: "twitch.tv",
    category: "video",
    status: "limited",
    notes: "VODs and clips when publicly available.",
  },
  {
    id: "x",
    name: "X",
    domain: "x.com",
    category: "social",
    status: "limited",
  },
  {
    id: "reddit",
    name: "Reddit",
    domain: "reddit.com",
    category: "social",
    status: "limited",
  },
  {
    id: "tiktok",
    name: "TikTok",
    domain: "tiktok.com",
    category: "social",
    status: "limited",
  },
  {
    id: "facebook",
    name: "Facebook",
    domain: "facebook.com",
    category: "social",
    status: "limited",
  },
  {
    id: "instagram",
    name: "Instagram",
    domain: "instagram.com",
    category: "social",
    status: "limited",
  },
  {
    id: "soundcloud",
    name: "SoundCloud",
    domain: "soundcloud.com",
    category: "other",
    status: "limited",
  },
  {
    id: "bandcamp",
    name: "Bandcamp",
    domain: "bandcamp.com",
    category: "other",
    status: "limited",
  },
  {
    id: "bbc",
    name: "BBC",
    domain: "bbc.co.uk",
    category: "news",
    status: "limited",
  },
  {
    id: "cnn",
    name: "CNN",
    domain: "cnn.com",
    category: "news",
    status: "limited",
  },
];

export const CATEGORY_LABELS: Record<CatalogSite["category"], string> = {
  video: "Video platforms",
  social: "Social",
  news: "News & media",
  direct: "Direct files",
  other: "Other sources",
};
