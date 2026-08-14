const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

function runAudit() {
  const homeDir = os.homedir();
  const claudeSkillsPath = path.join(homeDir, '.claude', 'skills');
  const agentsSkillsPath = path.join(homeDir, '.agents', 'skills');
  const registryPath = path.join(__dirname, '..', '..', 'data', 'registry.yaml');

  let registry = { skills: [], viec: [] };
  try {
    const fileContents = fs.readFileSync(registryPath, 'utf8');
    registry = yaml.load(fileContents);
  } catch (e) {
    console.error("Không thể đọc file registry.yaml:", e);
    return null;
  }

  const getSubDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);
    } catch (e) {
      return [];
    }
  };

  const claudeSkills = getSubDirs(claudeSkillsPath);
  const agentsSkills = getSubDirs(agentsSkillsPath);
  
  const registrySkillIds = registry.skills.map(s => s.id);

  const coTrongMayKhongCoTrongSo = claudeSkills.filter(id => !registrySkillIds.includes(id));
  const coTrongSoKhongCoTrongMay = registrySkillIds.filter(id => !claudeSkills.includes(id));
  const namSaiThuMuc = agentsSkills.filter(id => !claudeSkills.includes(id));

  return {
    coTrongMayKhongCoTrongSo,
    coTrongSoKhongCoTrongMay,
    namSaiThuMuc
  };
}

module.exports = {
  runAudit
};
