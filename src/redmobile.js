const moment = require('moment')
const cheerio = require('cheerio')
const { log } = require('cozy-konnector-libs')

module.exports = async function parseRedMobileBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client-red.sfr.fr'

  const firstBill = $($('.sr-container-main > .sr-container-wrapper-m').get(0))
  const firstBillUrl = $('#lien-telecharger-pdf').attr('href')

  if (firstBillUrl) {
    // The year is not provided, but we assume this is the current year or that
    // it will be provided if different from the current year
    let firstBillDate = firstBill
      .find('.sr-container-content span > span')
      .last()
    firstBillDate = $(firstBillDate)
      .text()
      .trim()
    firstBillDate = moment(firstBillDate, 'D MMM YYYY')
    const price = firstBill
      .find('.sr-text-25B')
      .text()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`,
      filename: getFileName(firstBillDate),
      vendor: 'SFR RED MOBILE'
    }
    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  async function getMoreBills() {
    // find some more rows if any
    // Always respond a 404, we don't know why. It's not a missing header
    return await this.request(
      `${baseURL}/facture-mobile/consultation/plusDeFactures`
    )
  }

  //  const $billsHtml = await getMoreBills.bind(this)()
  const $billsHtml = $ // use the 6 month history as a backup
  const divs = Array.from($billsHtml('div.sr-container-content-line'))
  for (const div of divs) {
    const $div = cheerio.load(div)
    const fileurl = baseURL + $div('a').attr('href')
    const amount = parseFloat(
      $div('span.sr-text-18B')
        .text()
        .trim()
        .replace('€', '')
        .replace(',', '.')
    )
    const date = moment(
      $div('span.sr-text-grey-14')
        .find('span')
        // if two span date are present, we chose the second
        // because first one is 'Payé le ...'
        .last()
        .text(),
      'DD MMMM YYYY'
    ).toDate()
    const bill = {
      fileurl,
      amount,
      date
    }
    result.push(bill)
  }

  return result
}

function getFileName(date) {
  return `${date.format('YYYY_MM')}_SfrRed.pdf`
}
