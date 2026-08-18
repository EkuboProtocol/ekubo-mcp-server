import lidoSkill from "../skills/use-lido/SKILL.md";
import lidoDiscovery from "../skills/use-lido/references/discovery.md";
import merklSkill from "../skills/use-merkl/SKILL.md";
import merklDiscovery from "../skills/use-merkl/references/discovery.md";
import morphoSkill from "../skills/use-morpho/SKILL.md";
import morphoDiscovery from "../skills/use-morpho/references/discovery.md";
import skySkill from "../skills/use-sky/SKILL.md";
import skyDiscovery from "../skills/use-sky/references/discovery.md";

export const PROTOCOL_SKILLS = [
  {
    name: "use-morpho",
    title: "Use Morpho",
    description: "Direct Morpho discovery and safe Vault V2 transaction preparation",
    skill: morphoSkill,
    reference: morphoDiscovery,
  },
  {
    name: "use-sky",
    title: "Use Sky",
    description: "Direct Sky savings discovery and safe sUSDS transaction preparation",
    skill: skySkill,
    reference: skyDiscovery,
  },
  {
    name: "use-lido",
    title: "Use Lido",
    description: "Direct Lido discovery and safe staking or withdrawal preparation",
    skill: lidoSkill,
    reference: lidoDiscovery,
  },
  {
    name: "use-merkl",
    title: "Use Merkl",
    description: "Direct Merkl reward discovery and proof-verified claim preparation",
    skill: merklSkill,
    reference: merklDiscovery,
  },
] as const;

export const PROTOCOL_SKILL_HTTP_FILES = new Map<string, string>(
  PROTOCOL_SKILLS.flatMap((skill) => [
    [`/skills/${skill.name}/SKILL.md`, skill.skill] as const,
    [`/skills/${skill.name}/references/discovery.md`, skill.reference] as const,
  ]),
);
