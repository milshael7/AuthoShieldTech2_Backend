const { audit } = require('../lib/audit');
const { createNotification } = require('../lib/notify');

function guidanceForIssue(issue){
  const steps = [
    "Confirm scope (what, who, when).",
    "Preserve evidence (logs, timestamps).",
    "Contain (isolate impacted accounts/systems).",
    "Eradicate (patch, rotate creds, remove artifacts).",
    "Recover (restore, monitor).",
    "Document for reporting."
  ];
  if(issue?.type==='phishing') steps.unshift("Send an internal reminder: don’t click unexpected links.");
  if(issue?.type==='malware') steps.unshift("Disconnect impacted endpoint from the network if possible.");
  return steps;
}

function createProject({ actorId, companyId=null, title, issue }){
  const project = { id:`PRJ-${Date.now()}`, title, companyId, issue, createdAt:new Date().toISOString(), status:'Open', steps: guidanceForIssue(issue), notes:[] };
  audit({ actorId, action:'AUTOPROTECT_PROJECT_CREATED', targetType:'Project', targetId:project.id, metadata:{companyId,title,issue} });
  createNotification({ companyId, severity:'info', title:'New project created', message:`Project "${title}" is open. Review steps and complete actions.` });
  return project;
}
module.exports = { guidanceForIssue, createProject };
