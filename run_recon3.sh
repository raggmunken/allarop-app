set +e
declare -A SITES=(
  [klaravik3]="https://www.klaravik.se/auktion/"
  [netauktion3]="https://www.netauktion.se/auktion/display/thisweek"
  [auktionsgruppen3]="https://www.auktionsgruppen.se/PagaendeAuktioner.aspx"
  [kronofogden3]="https://auktionstorget.kronofogden.se/auktionstorget"
  [sajabvintage3]="https://www.sajabvintage.se/auktioner"
  [auktiona3]="https://auktiona.se/auktioner?cats=fordon"
)
for name in "${!SITES[@]}"; do
  echo "===== $name : ${SITES[$name]} ====="
  timeout 90 npx tsx src/recon/verify.ts "${SITES[$name]}" >"recon-output/log_$name.txt" 2>&1
  echo "  klar ($name) exit $?"
done
echo "BATCH3 KLAR"
