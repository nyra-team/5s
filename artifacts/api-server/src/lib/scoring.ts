export interface ScoreJson {
  sort: number;
  set: number;
  shine: number;
  standardize: number;
  sustain: number;
}

const SUGGESTIONS: Record<keyof ScoreJson, string[]> = {
  sort: [
    "Remove unnecessary items from the workspace",
    "Label items that belong and discard the rest",
    "Conduct a red-tag exercise to identify unneeded items",
  ],
  set: [
    "Designate specific locations for all tools and materials",
    "Use shadow boards or labels for tool placement",
    "Ensure frequently used items are within arm's reach",
  ],
  shine: [
    "Clean all work surfaces and equipment thoroughly",
    "Establish a daily cleaning routine for the area",
    "Inspect equipment during cleaning for early defect detection",
  ],
  standardize: [
    "Create visual standards for how the area should look",
    "Post reference photos at the workstation",
    "Document cleaning and organizing procedures",
  ],
  sustain: [
    "Schedule regular 5S audits for this area",
    "Recognize teams that maintain high 5S standards",
    "Include 5S in shift handover checklists",
  ],
};

export function generateScore(): { scoreJson: ScoreJson; scoreTotal: number; suggestions: string[] } {
  const scoreJson: ScoreJson = {
    sort: Math.floor(Math.random() * 4) + 2,
    set: Math.floor(Math.random() * 4) + 2,
    shine: Math.floor(Math.random() * 4) + 2,
    standardize: Math.floor(Math.random() * 4) + 2,
    sustain: Math.floor(Math.random() * 4) + 2,
  };

  const scoreTotal = scoreJson.sort + scoreJson.set + scoreJson.shine + scoreJson.standardize + scoreJson.sustain;

  const pillars = Object.entries(scoreJson) as [keyof ScoreJson, number][];
  pillars.sort((a, b) => a[1] - b[1]);

  const suggestions: string[] = [];
  for (const [pillar] of pillars) {
    if (suggestions.length >= 3) break;
    const pool = SUGGESTIONS[pillar];
    suggestions.push(pool[Math.floor(Math.random() * pool.length)]);
  }

  while (suggestions.length < 3) {
    const randomPillar = pillars[Math.floor(Math.random() * pillars.length)][0];
    const pool = SUGGESTIONS[randomPillar];
    const s = pool[Math.floor(Math.random() * pool.length)];
    if (!suggestions.includes(s)) suggestions.push(s);
  }

  return { scoreJson, scoreTotal, suggestions };
}

export function getCurrentShift(): { shift: string; startTime: string; endTime: string } {
  const now = new Date();
  const hour = now.getHours();

  if (hour >= 6 && hour < 14) {
    return { shift: "A", startTime: "6:00 AM", endTime: "2:00 PM" };
  } else if (hour >= 14 && hour < 22) {
    return { shift: "B", startTime: "2:00 PM", endTime: "10:00 PM" };
  } else {
    return { shift: "C", startTime: "10:00 PM", endTime: "6:00 AM" };
  }
}

export function getTodayDateString(): string {
  const now = new Date();
  return now.toISOString().split("T")[0];
}
