const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONTEXT_MAP_PATH = path.join(ROOT_DIR, 'sherlog.context.json');
const VELOCITY_SUMMARY_PATH = path.join(ROOT_DIR, 'velocity-artifacts', 'velocity-summary.json');
const ATLAS_OUT = path.join(ROOT_DIR, 'TERMINUS_ATLAS.md');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function generate() {
  const context = readJson(CONTEXT_MAP_PATH);
  const velocity = readJson(VELOCITY_SUMMARY_PATH);

  let md = `# 🌌 TERMINUS ATLAS (Living Manifest)\n\n`;
  md += `> Automatically generated on **${new Date().toISOString()}** via Sherlog Context Mapping.\n\n`;

  md += `---\n\n## 🧭 1. Architectural Zones & Beliefs\n\n`;
  md += `This section maps exactly what the repository structures govern, used for context drift detection.\n\n`;
  
  if (context && context.zones) {
    context.zones.forEach(zone => {
      md += `### 📂 ${zone.name}\n`;
      md += `- **Paths:** \`${zone.paths.join('`, `')}\`\n`;
      md += `- **Belief:** ${zone.belief}\n\n`;
    });
  } else {
    md += `*No \`sherlog.context.json\` found or parsed. Run \`npm run sherlog:init-context\`.*\n\n`;
  }

  md += `---\n\n## 🩺 2. Engine Health & Velocity\n\n`;
  if (velocity) {
    md += `| Metric | Value |\n|--|--|\n`;
    md += `| **Commits/Day (Pacing)** | ${velocity.velocity?.commits_per_day || 'N/A'} |\n`;
    md += `| **Salience Score** | ${velocity.salience?.current?.total_score || velocity.salience?.total_score || 'N/A'} |\n`;
    md += `| **Gaps Detected** | ${velocity.gaps?.total || 0} |\n\n`;

    md += `### 🚨 Current Gaps (Top 5)\n`;
    const ranked = velocity.salience?.ranked || velocity.gaps?.list || [];
    if (ranked.length > 0) {
      ranked.slice(0, 5).forEach((gap, i) => {
        const gapName = typeof gap === 'string' ? gap : gap.gap;
        const gapScore = gap.score ? ` (Score: ${gap.score})` : '';
        const gapTier = gap.tier ? ` - *Tier: ${gap.tier}*` : '';
        md += `${i + 1}. **${gapName}**${gapScore}${gapTier}\n`;
      });
      md += '\n';
    } else {
      md += `*No active gaps detected! System is in full compliance.*\n\n`;
    }
    
    md += `### 🤖 AI Recommendation\n`;
    if (velocity.recommendation) {
      md += `**Action:** ${velocity.recommendation.action}\n\n`;
      md += `> ${velocity.recommendation.rationale}\n\n`;
    } else {
      md += `*No pressing recommendations right now.*\n\n`;
    }
  } else {
    md += `*No \`velocity-summary.json\` found. Run \`npm run velocity:report\` or check \`velocity-artifacts/\`.*\n\n`;
  }

  md += `---\n\n`;
  md += `### 🔮 Operations\n`;
  md += `To manually regenerate this Atlas: \`npm run sherlog:manifest\`\n`;

  fs.writeFileSync(ATLAS_OUT, md, 'utf8');
  console.log(`Successfully generated Living Manifest to ${ATLAS_OUT}`);
}

generate();
