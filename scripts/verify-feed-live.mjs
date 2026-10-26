async function main() {
  const base = 'http://127.0.0.1:3000';
  const email = `live_verify_${Date.now()}@example.com`;
  console.log('1. Registering user:', email);
  const regRes = await fetch(`${base}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', name: 'Live Verification User' })
  });
  if (!regRes.ok) throw new Error(`Register failed: ${regRes.status} ${await regRes.text()}`);
  const regData = await regRes.json();
  const token = regData.tokens.accessToken;

  console.log('2. Onboarding organization...');
  const orgRes = await fetch(`${base}/v1/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: 'Verification Org',
      timezone: 'UTC',
      branchName: 'Main Site',
      departments: ['Operations']
    })
  });
  if (!orgRes.ok) throw new Error(`Org creation failed: ${orgRes.status} ${await orgRes.text()}`);
  const orgData = await orgRes.json();
  const orgToken = orgData.tokens.accessToken;
  const branchId = orgData.branch.id;
  const deptId = orgData.departments[0].id;

  console.log('2b. Creating and publishing a shift to generate real activity events...');
  const shiftRes = await fetch(`${base}/v1/scheduling/shifts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orgToken}` },
    body: JSON.stringify({
      branchId,
      departmentId: deptId,
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      endsAt: new Date(Date.now() + 115200000).toISOString(),
      timeZone: 'UTC',
      status: 'draft'
    })
  });
  if (!shiftRes.ok) throw new Error(`Shift creation failed: ${shiftRes.status} ${await shiftRes.text()}`);
  const shiftData = await shiftRes.json();
  const shiftId = shiftData.shift.id;

  const pubRes = await fetch(`${base}/v1/scheduling/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orgToken}` },
    body: JSON.stringify({ shiftIds: [shiftId] })
  });
  if (!pubRes.ok) throw new Error(`Shift publish failed: ${pubRes.status} ${await pubRes.text()}`);

  console.log('3. Requesting GET /v1/activity?limit=20...');
  const feedRes = await fetch(`${base}/v1/activity?limit=20`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${orgToken}` }
  });
  const feedStatus = feedRes.status;
  const feedData = await feedRes.json();

  console.log('FEED_ENDPOINT_HTTP_STATUS:', feedStatus);
  console.log('FEED_ENDPOINT_RESPONSE:', JSON.stringify({
    status: feedStatus,
    eventsCount: Array.isArray(feedData.events) ? feedData.events.length : 0,
    hasMore: feedData.hasMore,
    nextCursor: feedData.nextCursor,
    events: feedData.events
  }, null, 2));
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
