const moment = require('moment')
const cheerio = require('cheerio')
const { log, cozyClient } = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

module.exports = async function parseMobileBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('.sr-container-wrapper-m').eq(0)
  const firstBillUrl = $firstBill.find('#lien-telecharger-pdf').attr('href')

  if (firstBillUrl) {
    const firstBillDate = moment(
      $firstBill
        .find('.sr-container-content')
        .eq(0)
        .find('span')
        .last()
        .text(),
      'DD MMMM YYYY'
    )
    const price = $firstBill
      .find('.sr-container-content')
      .eq(0)
      .find('span')
      .first()
      .text()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`,
      metadata: {
        contentAuthor: 'sfr.fr',
        issueDate: firstBillDate.toDate(),
        datetime: new Date(),
        datetimeLabel: `issueDate`,
        isSubscription: true,
        carbonCopy: true,
        qualification: Qualification.getByLabel('phone_invoice')
      }
    }
    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  async function getMoreBills() {
    // fetching old bills list recursively
    // The last fetched html should contains all history except the most recent bill
    const $ = await this.request(
      `${baseURL}/facture-mobile/consultation/plusDeFactures`
    )
    // Js call detection or button text detection, all two should work
    if (
      $.html().includes('plusFacture()') ||
      $.html().includes('Plus&#xA0;de&#xA0;factures')
    ) {
      // Need more work to scroll more bills
      //  return getMoreBills.bind(this)()
      return $
    } else {
      return $
    }
  }

  const $billsHtml = await getMoreBills.bind(this)()
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
      date,
      metadata: {
        contentAuthor: 'sfr.fr',
        issueDate: date.toDate(),
        datetime: new Date(),
        datetimeLabel: `issueDate`,
        isSubscription: true,
        carbonCopy: true,
        qualification: Qualification.getByLabel('phone_invoice')
      }
    }
    result.push(bill)
  }
  return result
}
