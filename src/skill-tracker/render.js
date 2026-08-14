function formatMessage(strings, ...values) {
  let result = '';
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += values[i];
    }
  }
  // Loại bỏ các dấu gạch ngang dài và các từ cấm
  return result
    .replace(/[—–]/g, ' ')
    .replace(/thực chiến/gi, 'thực tế')
    .replace(/chốt đơn|chốt sale|chốt khách|chốt/gi, 'kết nạp')
    .replace(/\blời\b|\blời thêm\b/gi, 'lợi nhuận');
}

function renderMorningReminder(viec, skill) {
  if (!viec) return '';
  return formatMessage`Chào anh.
Hôm nay có việc cần ưu tiên xử lý:
Công việc: ${viec.ten}
Hạn chót: ${viec.han}
${skill && skill.lenh_cai ? `Lệnh cài đặt: \`${skill.lenh_cai}\`` : ''}`;
}

function renderOverdueWarning(viec, daysOverdue, requireDecision) {
  const baseMessage = formatMessage`⚠️ Cảnh báo: Việc "${viec.ten}" đã quá hạn ${daysOverdue} ngày.`;
  if (requireDecision) {
    return baseMessage + '\n\n' + formatMessage`Skill này đã nằm im ${daysOverdue} ngày. Dùng thật trong 3 ngày tới, hay chuyển Lưu trữ và gỡ khỏi máy?`;
  }
  return baseMessage;
}

function renderAuditReport(auditResult, studyingSkills) {
  let msg = formatMessage`=== BÁO CÁO RÀ SOÁT KHO SKILL ===\n\n`;
  
  msg += formatMessage`1. CÓ TRONG MÁY, KHÔNG CÓ TRONG SỔ:\n`;
  if (auditResult.coTrongMayKhongCoTrongSo.length === 0) {
    msg += `  Không có.\n`;
  } else {
    auditResult.coTrongMayKhongCoTrongSo.forEach((id) => {
      msg += `  • ${id}\n`;
    });
  }

  msg += formatMessage`\n2. CÓ TRONG SỔ, KHÔNG CÓ TRONG MÁY:\n`;
  if (auditResult.coTrongSoKhongCoTrongMay.length === 0) {
    msg += `  Không có.\n`;
  } else {
    auditResult.coTrongSoKhongCoTrongMay.forEach((id) => {
      msg += `  • ${id}\n`;
    });
  }

  msg += formatMessage`\n3. NẰM SAI THƯ MỤC:\n`;
  if (auditResult.namSaiThuMuc.length === 0) {
    msg += `  Không có.\n`;
  } else {
    auditResult.namSaiThuMuc.forEach((id) => {
      msg += `  • ${id} (Lệnh sửa: \`cp -r ~/.agents/skills/${id} ~/.claude/skills/${id}\`)\n`;
    });
  }

  msg += formatMessage`\n=== SKILL ĐANG NGHIÊN CỨU ===\n`;
  if (studyingSkills.length === 0) {
    msg += `  Không có.\n`;
  } else {
    studyingSkills.forEach((s) => {
      msg += `  • ${s.ten} (Số ngày nằm im: ${s.daysIdle})\n`;
    });
  }

  if (studyingSkills.length > 2) {
    msg += formatMessage`\n❗️ CẢNH BÁO: Anh đang có ${studyingSkills.length} skill chưa dùng thật. Cần giải quyết xong mới được cài thêm.`;
  }

  return msg;
}

module.exports = {
  formatMessage,
  renderMorningReminder,
  renderOverdueWarning,
  renderAuditReport
};
