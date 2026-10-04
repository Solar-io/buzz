# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sidebar-order.spec.ts >> rendered sidebar order >> Channels: unread by recency, exactly four most used, then case-insensitive A-Z
- Location: tests/e2e/sidebar-order.spec.ts:224:3

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByTestId('channel-sidebar').locator('section[aria-label="Channels"]').locator('ul > li > button[data-active] span.truncate')
Timeout: 5000ms
- Expected  - 1
+ Received  + 1

@@ -3,9 +3,9 @@
    "alpha-old",
    "Violet",
    "tango",
    "Sierra",
    "romeo",
+   "zebra",
    "aardvark",
    "Bravo",
-   "zebra",
  ]

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByTestId('channel-sidebar').locator('section[aria-label="Channels"]').locator('ul > li > button[data-active] span.truncate')
    14 × locator resolved to 9 elements

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - main [ref=e4]:
    - generic [ref=e5]:
      - complementary [ref=e6]:
        - generic [ref=e7]:
          - generic [ref=e8]:
            - 'button "Buzz menu: settings, status and your account" [ref=e10] [cursor=pointer]':
              - generic [ref=e11]: B
              - generic [ref=e12]: Buzz
              - img [ref=e13]
            - generic [ref=e15]:
              - img [ref=e16]
              - textbox "Search messages" [ref=e19]:
                - /placeholder: Jump to…
              - generic [ref=e20]: ⌘K
            - generic [ref=e21]:
              - button "Inbox" [ref=e22] [cursor=pointer]:
                - img [ref=e23]
                - generic [ref=e26]: Inbox
              - button "Items" [ref=e27] [cursor=pointer]:
                - img [ref=e28]
                - generic [ref=e29]: Items
              - button "Shelf" [ref=e30] [cursor=pointer]:
                - img [ref=e31]
                - generic [ref=e34]: Shelf
              - button "Files" [ref=e35] [cursor=pointer]:
                - img [ref=e36]
                - generic [ref=e38]: Files
              - button "Terminal" [ref=e39] [cursor=pointer]:
                - img [ref=e40]
                - generic [ref=e43]: Terminal
          - navigation [ref=e44]:
            - generic [ref=e45]:
              - button "Daily Digest" [ref=e46] [cursor=pointer]:
                - img [ref=e47]
                - generic [ref=e50]: Daily Digest
              - button "Links" [ref=e52] [cursor=pointer]:
                - img [ref=e53]
                - generic [ref=e56]: Links
                - img [ref=e58]
            - region "Favorites" [ref=e60]:
              - button "Favorites" [expanded] [ref=e62] [cursor=pointer]:
                - img [ref=e63]
                - generic [ref=e65]: Favorites
              - list [ref=e66]:
                - listitem [ref=e67]:
                  - button "urgent-favorite 1 Options for urgent-favorite" [ref=e68] [cursor=pointer]:
                    - img [ref=e69]
                    - generic [ref=e72]: urgent-favorite
                    - generic [ref=e73]: "1"
                    - button "Options for urgent-favorite": ⋯
                - listitem [ref=e74]:
                  - button "VF Vera favorite" [ref=e75] [cursor=pointer]:
                    - generic [ref=e77]: VF
                    - generic [ref=e79]: Vera favorite
                - listitem [ref=e80]:
                  - button "Tango favorite Options for Tango favorite" [ref=e81] [cursor=pointer]:
                    - img [ref=e82]
                    - generic [ref=e85]: Tango favorite
                    - button "Options for Tango favorite": ⋯
                - listitem [ref=e86]:
                  - button "Sierra favorite Options for Sierra favorite" [ref=e87] [cursor=pointer]:
                    - img [ref=e88]
                    - generic [ref=e91]: Sierra favorite
                    - button "Options for Sierra favorite": ⋯
                - listitem [ref=e92]:
                  - button "RF Romeo favorite" [ref=e93] [cursor=pointer]:
                    - generic [ref=e95]: RF
                    - generic [ref=e97]: Romeo favorite
                - listitem [ref=e98]:
                  - button "zebra favorite Options for zebra favorite" [ref=e99] [cursor=pointer]:
                    - img [ref=e100]
                    - generic [ref=e103]: zebra favorite
                    - button "Options for zebra favorite": ⋯
                - listitem [ref=e104]:
                  - button "2 more" [ref=e105] [cursor=pointer]:
                    - img [ref=e106]
                    - generic [ref=e110]: 2 more
            - region "Channels" [ref=e111]:
              - generic [ref=e112]:
                - button "Channels" [expanded] [ref=e113] [cursor=pointer]:
                  - img [ref=e114]
                  - generic [ref=e116]: Channels
                - button "New channel" [ref=e117] [cursor=pointer]:
                  - img [ref=e118]
              - list [ref=e119]:
                - listitem [ref=e120]:
                  - button "zulu-new 1 Options for zulu-new" [ref=e121] [cursor=pointer]:
                    - img [ref=e122]
                    - generic [ref=e125]: zulu-new
                    - generic [ref=e126]: "1"
                    - button "Options for zulu-new": ⋯
                - listitem [ref=e127]:
                  - button "alpha-old 1 Options for alpha-old" [ref=e128] [cursor=pointer]:
                    - img [ref=e129]
                    - generic [ref=e132]: alpha-old
                    - generic [ref=e133]: "1"
                    - button "Options for alpha-old": ⋯
                - listitem [ref=e134]:
                  - button "Violet Options for Violet" [ref=e135] [cursor=pointer]:
                    - img [ref=e136]
                    - generic [ref=e139]: Violet
                    - button "Options for Violet": ⋯
                - listitem [ref=e140]:
                  - button "tango Options for tango" [ref=e141] [cursor=pointer]:
                    - img [ref=e142]
                    - generic [ref=e145]: tango
                    - button "Options for tango": ⋯
                - listitem [ref=e146]:
                  - button "Sierra Options for Sierra" [ref=e147] [cursor=pointer]:
                    - img [ref=e148]
                    - generic [ref=e151]: Sierra
                    - button "Options for Sierra": ⋯
                - listitem [ref=e152]:
                  - button "romeo Options for romeo" [ref=e153] [cursor=pointer]:
                    - img [ref=e154]
                    - generic [ref=e157]: romeo
                    - button "Options for romeo": ⋯
                - listitem [ref=e158]:
                  - button "zebra Options for zebra" [ref=e159] [cursor=pointer]:
                    - img [ref=e160]
                    - generic [ref=e163]: zebra
                    - button "Options for zebra": ⋯
                - listitem [ref=e164]:
                  - button "aardvark Options for aardvark" [ref=e165] [cursor=pointer]:
                    - img [ref=e166]
                    - generic [ref=e169]: aardvark
                    - button "Options for aardvark": ⋯
                - listitem [ref=e170]:
                  - button "Bravo Options for Bravo" [ref=e171] [cursor=pointer]:
                    - img [ref=e172]
                    - generic [ref=e175]: Bravo
                    - button "Options for Bravo": ⋯
                - listitem [ref=e176]:
                  - button "Show less" [expanded] [active] [ref=e177] [cursor=pointer]:
                    - img [ref=e178]
                    - generic [ref=e182]: Show less
            - region "Direct messages" [ref=e183]:
              - generic [ref=e184]:
                - button "Direct messages" [expanded] [ref=e185] [cursor=pointer]:
                  - img [ref=e186]
                  - generic [ref=e188]: Direct messages
                - button "New direct message" [ref=e189] [cursor=pointer]:
                  - img [ref=e190]
              - list [ref=e191]:
                - listitem [ref=e192]:
                  - button "UQ Unread Quinn 1" [ref=e193] [cursor=pointer]:
                    - generic [ref=e195]: UQ
                    - generic [ref=e197]: Unread Quinn
                    - generic [ref=e199]: "1"
                - listitem [ref=e200]:
                  - button "V Vera" [ref=e201] [cursor=pointer]:
                    - generic [ref=e203]: V
                    - generic [ref=e205]: Vera
                - listitem [ref=e206]:
                  - button "U Uma" [ref=e207] [cursor=pointer]:
                    - generic [ref=e209]: U
                    - generic [ref=e211]: Uma
                - listitem [ref=e212]:
                  - button "T Theo" [ref=e213] [cursor=pointer]:
                    - generic [ref=e215]: T
                    - generic [ref=e217]: Theo
                - listitem [ref=e218]:
                  - button "S Sam" [ref=e219] [cursor=pointer]:
                    - generic [ref=e221]: S
                    - generic [ref=e223]: Sam
                - listitem [ref=e224]:
                  - button "Z Zoe" [ref=e225] [cursor=pointer]:
                    - generic [ref=e227]: Z
                    - generic [ref=e229]: Zoe
                - listitem [ref=e230]:
                  - button "2 more" [ref=e231] [cursor=pointer]:
                    - img [ref=e232]
                    - generic [ref=e236]: 2 more
          - 'button "Vitals: Claude and Codex usage" [ref=e238] [cursor=pointer]':
            - generic [ref=e239]:
              - generic [ref=e240]: Claude
              - generic [ref=e241]: 2 accounts
            - generic [ref=e245]: 55%
            - generic [ref=e246]: 45% free · both dry Sun 12:55 AM · +11h
            - generic [ref=e247]:
              - generic [ref=e249]: Codex
              - generic [ref=e252]: 0% used
              - generic [ref=e253]: 100% free · resets Fri 4:13 PM
      - separator "Resize channel sidebar" [ref=e254]
      - generic [ref=e256]:
        - main [ref=e257]:
          - generic [ref=e259]:
            - generic [ref=e260]:
              - generic [ref=e261]:
                - 'button "Filter inbox: All" [ref=e262] [cursor=pointer]':
                  - text: All
                  - img [ref=e263]
                - generic [ref=e265]: 10 items
              - list [ref=e267]:
                - listitem [ref=e268]:
                  - button "B Bella Bella 11:54 AM Activity in Bella" [ref=e269] [cursor=pointer]:
                    - generic [ref=e271]: B
                    - generic [ref=e272]:
                      - generic [ref=e273]:
                        - generic [ref=e274]: Bella
                        - generic [ref=e275]:
                          - img [ref=e276]
                          - generic [ref=e278]: Bella
                        - generic [ref=e279]: 11:54 AM
                      - paragraph [ref=e280]: Activity in Bella
                - listitem [ref=e281]:
                  - button "A aaron aaron 11:52 AM Activity in aaron" [ref=e282] [cursor=pointer]:
                    - generic [ref=e284]: A
                    - generic [ref=e285]:
                      - generic [ref=e286]:
                        - generic [ref=e287]: aaron
                        - generic [ref=e288]:
                          - img [ref=e289]
                          - generic [ref=e291]: aaron
                        - generic [ref=e292]: 11:52 AM
                      - paragraph [ref=e293]: Activity in aaron
                - listitem [ref=e294]:
                  - button "Z Zoe Zoe 11:50 AM Activity in Zoe" [ref=e295] [cursor=pointer]:
                    - generic [ref=e297]: Z
                    - generic [ref=e298]:
                      - generic [ref=e299]:
                        - generic [ref=e300]: Zoe
                        - generic [ref=e301]:
                          - img [ref=e302]
                          - generic [ref=e304]: Zoe
                        - generic [ref=e305]: 11:50 AM
                      - paragraph [ref=e306]: Activity in Zoe
                - listitem [ref=e307]:
                  - button "S Sam Sam 11:49 AM Activity in Sam" [ref=e308] [cursor=pointer]:
                    - generic [ref=e310]: S
                    - generic [ref=e311]:
                      - generic [ref=e312]:
                        - generic [ref=e313]: Sam
                        - generic [ref=e314]:
                          - img [ref=e315]
                          - generic [ref=e317]: Sam
                        - generic [ref=e318]: 11:49 AM
                      - paragraph [ref=e319]: Activity in Sam
                - listitem [ref=e320]:
                  - button "RF Romeo favorite Romeo favorite 11:49 AM Activity in Romeo favorite" [ref=e321] [cursor=pointer]:
                    - generic [ref=e323]: RF
                    - generic [ref=e324]:
                      - generic [ref=e325]:
                        - generic [ref=e326]: Romeo favorite
                        - generic [ref=e327]:
                          - img [ref=e328]
                          - generic [ref=e330]: Romeo favorite
                        - generic [ref=e331]: 11:49 AM
                      - paragraph [ref=e332]: Activity in Romeo favorite
                - listitem [ref=e333]:
                  - button "T Theo Theo 11:47 AM Activity in Theo" [ref=e334] [cursor=pointer]:
                    - generic [ref=e336]: T
                    - generic [ref=e337]:
                      - generic [ref=e338]:
                        - generic [ref=e339]: Theo
                        - generic [ref=e340]:
                          - img [ref=e341]
                          - generic [ref=e343]: Theo
                        - generic [ref=e344]: 11:47 AM
                      - paragraph [ref=e345]: Activity in Theo
                - listitem [ref=e346]:
                  - button "U Uma Uma 11:45 AM Activity in Uma" [ref=e347] [cursor=pointer]:
                    - generic [ref=e349]: U
                    - generic [ref=e350]:
                      - generic [ref=e351]:
                        - generic [ref=e352]: Uma
                        - generic [ref=e353]:
                          - img [ref=e354]
                          - generic [ref=e356]: Uma
                        - generic [ref=e357]: 11:45 AM
                      - paragraph [ref=e358]: Activity in Uma
                - listitem [ref=e359]:
                  - button "V Vera Vera 11:44 AM Activity in Vera" [ref=e360] [cursor=pointer]:
                    - generic [ref=e362]: V
                    - generic [ref=e363]:
                      - generic [ref=e364]:
                        - generic [ref=e365]: Vera
                        - generic [ref=e366]:
                          - img [ref=e367]
                          - generic [ref=e369]: Vera
                        - generic [ref=e370]: 11:44 AM
                      - paragraph [ref=e371]: Activity in Vera
                - listitem [ref=e372]:
                  - button "VF Vera favorite Vera favorite 11:44 AM Activity in Vera favorite" [ref=e373] [cursor=pointer]:
                    - generic [ref=e375]: VF
                    - generic [ref=e376]:
                      - generic [ref=e377]:
                        - generic [ref=e378]: Vera favorite
                        - generic [ref=e379]:
                          - img [ref=e380]
                          - generic [ref=e382]: Vera favorite
                        - generic [ref=e383]: 11:44 AM
                      - paragraph [ref=e384]: Activity in Vera favorite
                - listitem [ref=e385]:
                  - button "UQ Unread Quinn Unread Quinn 11:42 AM Activity in Unread Quinn" [ref=e386] [cursor=pointer]:
                    - generic [ref=e388]: UQ
                    - generic [ref=e390]:
                      - generic [ref=e391]:
                        - generic [ref=e392]: Unread Quinn
                        - generic [ref=e393]:
                          - img [ref=e394]
                          - generic [ref=e396]: Unread Quinn
                        - generic [ref=e397]: 11:42 AM
                      - paragraph [ref=e398]: Activity in Unread Quinn
            - generic [ref=e400]:
              - img [ref=e401]
              - paragraph [ref=e404]: Select a conversation to read it in context.
        - generic [ref=e405]:
          - separator "Resize side panel" [ref=e406]
          - generic [ref=e407]:
            - tablist "Side panel" [ref=e408]:
              - generic [ref=e409]:
                - tab "Work" [selected] [ref=e411] [cursor=pointer]
                - tab "Canvas" [ref=e413] [cursor=pointer]
            - complementary "Work" [ref=e416]:
              - generic [ref=e418]:
                - group "Scope" [ref=e419]:
                  - generic [ref=e420]: Scope
                  - button "Everywhere" [pressed] [ref=e421] [cursor=pointer]
                  - button "This channel" [disabled] [ref=e422]
                - button "Collapse Work" [ref=e423] [cursor=pointer]:
                  - img [ref=e424]
              - region "Needs you" [ref=e427]:
                - button "Needs you 0" [expanded] [ref=e428] [cursor=pointer]:
                  - img [ref=e429]
                  - text: Needs you
                  - generic [ref=e432]: "0"
                - paragraph [ref=e433]: Nothing needs you right now.
              - region "Running" [ref=e434]:
                - button "Running 0" [expanded] [ref=e435] [cursor=pointer]:
                  - img [ref=e436]
                  - text: Running
                  - generic [ref=e439]: "0"
                - paragraph [ref=e440]: No agents are working.
              - button "Done today 0" [ref=e441] [cursor=pointer]:
                - img [ref=e442]
                - img [ref=e444]
                - generic [ref=e446]: Done today
                - generic [ref=e447]: "0"
  - region "Notifications alt+T"
```

# Test source

```ts
  129 |         );
  130 |         localStorage.setItem("buzz.collapsed-sections.v1", "[]");
  131 |         localStorage.setItem("buzz-theme", "buzz");
  132 |         localStorage.setItem("buzz-follow-system", "false");
  133 |       } catch {
  134 |         // Sandboxed frames have no localStorage.
  135 |       }
  136 |     },
  137 |     { visits, read, favorites },
  138 |   );
  139 |   const errors: string[] = [];
  140 |   page.on("pageerror", (error) => errors.push(error.message));
  141 |   await routeUsageHub(page);
  142 |   await installMockRelay(page, events);
  143 |   // A non-conversation view avoids marking a fixture row seen or bumping
  144 |   // its visit score merely by mounting the app.
  145 |   await signIn(page, "/repos?view=inbox", viewerKey);
  146 |   await expect(page.getByTestId("channel-sidebar")).toBeVisible();
  147 |   await page.mouse.move(1_000, 100);
  148 |   return errors;
  149 | }
  150 | 
  151 | async function sectionRows(
  152 |   page: Page,
  153 |   label: string,
  154 |   screenshotName: string,
  155 | ): Promise<Locator> {
  156 |   const section = page
  157 |     .getByTestId("channel-sidebar")
  158 |     .locator(`section[aria-label="${label}"]`);
  159 |   await expect(section).toBeVisible();
  160 |   await expect(section.getByTestId("section-more")).toBeVisible();
  161 |   await shot(page, `${screenshotName}-truncated`);
  162 |   await section.getByTestId("section-more").click();
  163 |   // Clicking "N more" leaves the pointer over the held list. Move it out
  164 |   // before reading order so pending activity/profile updates can re-rank.
  165 |   await page.mouse.move(1_000, 100);
  166 |   await expect(section.getByTestId("section-more")).toHaveText("Show less");
  167 |   await section.scrollIntoViewIfNeeded();
  168 |   await page.mouse.move(1_000, 100);
  169 |   await shot(page, `${screenshotName}-expanded`);
  170 |   return section.locator("ul > li > button[data-active] span.truncate");
  171 | }
  172 | 
  173 | // Local fallback is headed; CI retains its normal isolated browser.
  174 | test.use({
  175 |   viewport: { width: 1_440, height: 1_200 },
  176 |   headless: !!process.env.CI,
  177 | });
  178 | 
  179 | const consoleErrors = new WeakMap<Page, string[]>();
  180 | 
  181 | test.beforeEach(async ({ page }) => {
  182 |   const errors: string[] = [];
  183 |   consoleErrors.set(page, errors);
  184 |   page.on("console", (message) => {
  185 |     if (message.type() === "error") errors.push(message.text());
  186 |   });
  187 | });
  188 | 
  189 | test.describe("rendered sidebar order", () => {
  190 |   test.afterEach(async ({ page }, testInfo) => {
  191 |     await testInfo.attach("console-errors", {
  192 |       body: JSON.stringify(consoleErrors.get(page) ?? [], null, 2),
  193 |       contentType: "application/json",
  194 |     });
  195 |     await testInfo.attach("sidebar-state", {
  196 |       body: JSON.stringify(
  197 |         await page.evaluate(() => ({
  198 |           visits: localStorage.getItem("buzz.sidebar-visits.v1"),
  199 |           read: localStorage.getItem("buzz.read-state.v1"),
  200 |           favorites: localStorage.getItem("buzz.channel-prefs.v1"),
  201 |           pointerOverList: document.querySelector("nav:hover") !== null,
  202 |           sections: Array.from(
  203 |             document.querySelectorAll(
  204 |               '[data-testid="channel-sidebar"] section',
  205 |             ),
  206 |             (section) => ({
  207 |               name: section.getAttribute("aria-label"),
  208 |               labels: Array.from(
  209 |                 section.querySelectorAll(
  210 |                   "ul > li > button[data-active] span.truncate",
  211 |                 ),
  212 |                 (label) => label.textContent,
  213 |               ),
  214 |             }),
  215 |           ),
  216 |         })),
  217 |         null,
  218 |         2,
  219 |       ),
  220 |       contentType: "application/json",
  221 |     });
  222 |   });
  223 | 
  224 |   test("Channels: unread by recency, exactly four most used, then case-insensitive A-Z", async ({
  225 |     page,
  226 |   }) => {
  227 |     const errors = await seedSidebar(page);
  228 |     const rows = await sectionRows(page, "Channels", "channels");
> 229 |     await expect(rows).toHaveText([
      |                        ^ Error: expect(locator).toHaveText(expected) failed
  230 |       "zulu-new",
  231 |       "alpha-old",
  232 |       "Violet",
  233 |       "tango",
  234 |       "Sierra",
  235 |       "romeo",
  236 |       "aardvark",
  237 |       "Bravo",
  238 |       "zebra",
  239 |     ]);
  240 |     expect(errors).toEqual([]);
  241 |   });
  242 | 
  243 |   test("Direct messages: unread, exactly four most used, then A-Z by displayed profile name", async ({
  244 |     page,
  245 |   }) => {
  246 |     const errors = await seedSidebar(page);
  247 |     const rows = await sectionRows(page, "Direct messages", "dms");
  248 |     await expect(rows).toHaveText([
  249 |       "Unread Quinn",
  250 |       "Vera",
  251 |       "Uma",
  252 |       "Theo",
  253 |       "Sam",
  254 |       "aaron",
  255 |       "Bella",
  256 |       "Zoe",
  257 |     ]);
  258 |     expect(errors).toEqual([]);
  259 |   });
  260 | 
  261 |   test("Favorites: mixed channels and DMs use unread, four most used, then A-Z", async ({
  262 |     page,
  263 |   }) => {
  264 |     const errors = await seedSidebar(page);
  265 |     const rows = await sectionRows(page, "Favorites", "favorites");
  266 |     await expect(rows).toHaveText([
  267 |       "urgent-favorite",
  268 |       "Vera favorite",
  269 |       "Tango favorite",
  270 |       "Sierra favorite",
  271 |       "Romeo favorite",
  272 |       "aardvark favorite",
  273 |       "Bravo favorite",
  274 |       "zebra favorite",
  275 |     ]);
  276 |     expect(errors).toEqual([]);
  277 |   });
  278 | });
  279 | 
```